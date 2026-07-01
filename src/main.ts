import './style.css'
import * as THREE from 'three'
import RAPIER, { type RigidBody } from '@dimforge/rapier3d-compat'
import { connect, type Session } from '@genex-ai/multiplayer'
import { GENEX } from './genex.config'
import { RemoteInterpolator, type RemotePose } from './interpolation'

type Team = 'red' | 'blue' | 'spectator'

type PlayerSync = {
  x: number
  y: number
  z: number
  yaw: number
  team: Team
  slot: number
  name: string
  kick: number
  sprint: number
  t: number
}

type BallSync = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  seq: number
  by: string
}

type ScoreSync = {
  red: number
  blue: number
  last: string
}

type PlayerVisual = {
  group: THREE.Group
  body: THREE.Mesh
  ring: THREE.Mesh
  team: Team
}

type PhysicsPlayer = {
  body: RigidBody
}

const FIELD_WIDTH = 68
const FIELD_LENGTH = 105
const HALF_WIDTH = FIELD_WIDTH / 2
const HALF_LENGTH = FIELD_LENGTH / 2
const GOAL_HALF_WIDTH = 5.3
const GOAL_DEPTH = 5.5
const PLAYER_RADIUS = 0.62
const PLAYER_Y = 1
const BALL_RADIUS = 0.43
const KICK_RANGE = 3.0
const FIXED_STEP = 1 / 60
const BALL_ID = 'shared-ball'

const app = query<HTMLDivElement>('#app')
app.innerHTML = `
  <canvas id="game"></canvas>
  <div class="hud">
    <div class="scoreboard">
      <span class="team red">Red</span>
      <strong id="red-score">0</strong>
      <span class="divider">:</span>
      <strong id="blue-score">0</strong>
      <span class="team blue">Blue</span>
    </div>
    <div class="match-panel">
      <span id="team-badge">Joining</span>
      <span id="player-count">0 / 20</span>
      <span id="host-badge">Online</span>
    </div>
  </div>
  <div id="status" class="status">Joining online match...</div>
`

const canvas = query<HTMLCanvasElement>('#game')
const statusEl = query<HTMLDivElement>('#status')
const redScoreEl = query<HTMLElement>('#red-score')
const blueScoreEl = query<HTMLElement>('#blue-score')
const teamBadgeEl = query<HTMLElement>('#team-badge')
const playerCountEl = query<HTMLElement>('#player-count')
const hostBadgeEl = query<HTMLElement>('#host-badge')

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 280)
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
})
const timer = new THREE.Timer()
const textureLoader = new THREE.TextureLoader()
const audioLoader = new THREE.AudioLoader()
const listener = new THREE.AudioListener()
const playerInterpolator = new RemoteInterpolator()
const ballInterpolator = new RemoteInterpolator()
const playerVisuals = new Map<string, PlayerVisual>()
const physicsPlayers = new Map<string, PhysicsPlayer>()
const keys = new Set<string>()
const tmpVec = new THREE.Vector3()
const tmpVecB = new THREE.Vector3()
const tmpQuat = new THREE.Quaternion()
const worldUp = new THREE.Vector3(0, 1, 0)

let room: Session<PlayerSync> | null = null
let localPlayer: PlayerSync = makeLocalPlayer()
let score: ScoreSync = { red: 0, blue: 0, last: 'Kickoff' }
let latestBall: BallSync = defaultBall('')
let latestBallSeq = -1
let ballSeq = 0
let lastKickAt = 0
let lastSharedBallAt = 0
let lastScoreHud = ''
let lastSlotResolveAt = 0
let isHost = false
let wasHost = false
let onlineActive = false
let physicsAccumulator = 0
let kickBuffer: AudioBuffer | null = null
let publishTimer = 0
let animationId = 0

camera.add(listener)
renderer.setClearColor(0x07130f)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.02
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
timer.connect(document)

const kitMaterials = {
  red: new THREE.MeshStandardMaterial({ color: 0xd93b32, roughness: 0.64, metalness: 0.02 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x2776d8, roughness: 0.64, metalness: 0.02 }),
  spectator: new THREE.MeshStandardMaterial({ color: 0xcfd7df, roughness: 0.72, metalness: 0.01 }),
}
const localRingMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.78,
  side: THREE.DoubleSide,
})
const remoteRingMaterial = new THREE.MeshBasicMaterial({
  color: 0xe6eef2,
  transparent: true,
  opacity: 0.28,
  side: THREE.DoubleSide,
})
const grassMaterial = new THREE.MeshStandardMaterial({
  color: 0x2d7a3b,
  roughness: 0.92,
  metalness: 0,
})

await RAPIER.init()

const physicsWorld = new RAPIER.World({ x: 0, y: 0, z: 0 })
physicsWorld.timestep = FIXED_STEP
physicsWorld.numSolverIterations = 8
physicsWorld.maxCcdSubsteps = 2

const ballBody = physicsWorld.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, BALL_RADIUS, 0)
    .restrictTranslations(true, false, true)
    .setLinearDamping(0.82)
    .setAngularDamping(0.96)
    .setCcdEnabled(true),
)
physicsWorld.createCollider(
  RAPIER.ColliderDesc.ball(BALL_RADIUS).setRestitution(0.58).setFriction(0.86).setMass(0.43),
  ballBody,
)

const ballVisual = createBall()
scene.add(ballVisual)

setupScene()
setupInput()
resize()
window.addEventListener('resize', resize)

void start()

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

async function start() {
  statusEl.textContent = 'Joining online match...'

  room = await connect<PlayerSync>({
    url: GENEX.colyseusUrl,
    room: GENEX.slug,
    name: localPlayer.name,
  })
  onlineActive = true

  await delay(450)
  const assigned = assignTeamAndSlot()
  const spawn = spawnFor(assigned.team, assigned.slot)
  localPlayer = {
    ...localPlayer,
    team: assigned.team,
    slot: assigned.slot,
    x: spawn.x,
    y: PLAYER_Y,
    z: spawn.z,
    yaw: assigned.team === 'blue' ? Math.PI : 0,
  }

  publishLocalState()
  publishTimer = window.setInterval(publishLocalState, 66)
  room.on('leave', (id) => {
    removePlayerVisual(id)
    playerInterpolator.remove(id)
    removePhysicsPlayer(id)
  })

  loadMatchAssets()
  animationId = requestAnimationFrame(frame)
}

function makeLocalPlayer(): PlayerSync {
  const savedName = window.localStorage.getItem('football-player-name')
  const generatedName = `Player ${Math.floor(10 + Math.random() * 89)}`
  const name = savedName || generatedName
  window.localStorage.setItem('football-player-name', name)

  return {
    x: 0,
    y: PLAYER_Y,
    z: 0,
    yaw: 0,
    team: 'spectator',
    slot: 0,
    name,
    kick: 0,
    sprint: 0,
    t: 0,
  }
}

function defaultBall(by: string): BallSync {
  return {
    x: 0,
    y: BALL_RADIUS,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    seq: 0,
    by,
  }
}

function setupScene() {
  scene.fog = new THREE.Fog(0x86b6c9, 82, 185)

  const hemi = new THREE.HemisphereLight(0xeaf7ff, 0x24351d, 1.85)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xffffff, 3.5)
  sun.position.set(-30, 48, 26)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -70
  sun.shadow.camera.right = 70
  sun.shadow.camera.top = 78
  sun.shadow.camera.bottom = -78
  sun.shadow.camera.near = 5
  sun.shadow.camera.far = 130
  scene.add(sun)

  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_WIDTH, FIELD_LENGTH), grassMaterial)
  pitch.rotation.x = -Math.PI / 2
  pitch.receiveShadow = true
  scene.add(pitch)

  addPitchLines()
  addGoals()
  addStands()
  addPhysicsBoundaries()
}

function loadMatchAssets() {
  textureLoader.load('./assets/textures/short-striped-football-pitch-grass-with-subtle-wor/basecolor.png', (map) => {
    map.colorSpace = THREE.SRGBColorSpace
    map.wrapS = THREE.RepeatWrapping
    map.wrapT = THREE.RepeatWrapping
    map.repeat.set(7, 11)
    map.anisotropy = renderer.capabilities.getMaxAnisotropy()
    grassMaterial.map = map
    grassMaterial.needsUpdate = true
  })

  textureLoader.load('./assets/skybox/bright-afternoon-football-stadium-with-open-sky-an.jpg', (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.colorSpace = THREE.SRGBColorSpace
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envMap = pmrem.fromEquirectangular(texture).texture
    scene.background = texture
    scene.environment = envMap
    pmrem.dispose()
  })

  audioLoader.load('./assets/sfx/solid-football-kick-thump-on-grass.mp3', (buffer) => {
    kickBuffer = buffer
  })
}

function addPitchLines() {
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xf7fbf3, transparent: true, opacity: 0.95 })
  const y = 0.035

  addLine(
    [
      [-HALF_WIDTH, y, -HALF_LENGTH],
      [HALF_WIDTH, y, -HALF_LENGTH],
      [HALF_WIDTH, y, HALF_LENGTH],
      [-HALF_WIDTH, y, HALF_LENGTH],
    ],
    true,
    lineMaterial,
  )
  addLine(
    [
      [-HALF_WIDTH, y, 0],
      [HALF_WIDTH, y, 0],
    ],
    false,
    lineMaterial,
  )
  addCircle(0, 0, 9.15, lineMaterial)
  addBoxLine(0, -HALF_LENGTH, 40.3, 16.5, lineMaterial)
  addBoxLine(0, HALF_LENGTH, 40.3, -16.5, lineMaterial)
  addBoxLine(0, -HALF_LENGTH, 18.3, 5.5, lineMaterial)
  addBoxLine(0, HALF_LENGTH, 18.3, -5.5, lineMaterial)
}

function addLine(points: [number, number, number][], closed: boolean, material: THREE.LineBasicMaterial) {
  const vectors = points.map((point) => new THREE.Vector3(point[0], point[1], point[2]))
  if (closed) vectors.push(vectors[0].clone())
  const geometry = new THREE.BufferGeometry().setFromPoints(vectors)
  const line = new THREE.Line(geometry, material)
  scene.add(line)
}

function addCircle(x: number, z: number, radius: number, material: THREE.LineBasicMaterial) {
  const points: [number, number, number][] = []
  for (let i = 0; i < 96; i += 1) {
    const angle = (i / 96) * Math.PI * 2
    points.push([x + Math.cos(angle) * radius, 0.04, z + Math.sin(angle) * radius])
  }
  addLine(points, true, material)
}

function addBoxLine(centerX: number, goalZ: number, width: number, depth: number, material: THREE.LineBasicMaterial) {
  const half = width / 2
  addLine(
    [
      [centerX - half, 0.04, goalZ],
      [centerX - half, 0.04, goalZ + depth],
      [centerX + half, 0.04, goalZ + depth],
      [centerX + half, 0.04, goalZ],
    ],
    false,
    material,
  )
}

function addGoals() {
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f7f4, roughness: 0.35, metalness: 0.18 })
  const netMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
  })

  for (const side of [-1, 1]) {
    const z = side * HALF_LENGTH
    for (const x of [-GOAL_HALF_WIDTH, GOAL_HALF_WIDTH]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.45, 16), postMaterial)
      post.position.set(x, 1.22, z)
      post.castShadow = true
      scene.add(post)
    }

    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, GOAL_HALF_WIDTH * 2, 16), postMaterial)
    bar.position.set(0, 2.42, z)
    bar.rotation.z = Math.PI / 2
    bar.castShadow = true
    scene.add(bar)

    const net = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_WIDTH * 2, 2.4, 8, 2), netMaterial)
    net.position.set(0, 1.2, z + side * GOAL_DEPTH)
    net.rotation.y = side > 0 ? Math.PI : 0
    scene.add(net)
  }
}

function addStands() {
  const standMaterial = new THREE.MeshStandardMaterial({ color: 0x263940, roughness: 0.78, metalness: 0.08 })
  const seatRed = new THREE.MeshStandardMaterial({ color: 0xb53b35, roughness: 0.72 })
  const seatBlue = new THREE.MeshStandardMaterial({ color: 0x2e6fae, roughness: 0.72 })

  const standGeo = new THREE.BoxGeometry(1, 1, 1)
  for (const side of [-1, 1]) {
    const stand = new THREE.Mesh(standGeo, standMaterial)
    stand.scale.set(FIELD_WIDTH + 22, 5, 4)
    stand.position.set(0, 2.2, side * (HALF_LENGTH + 12))
    stand.receiveShadow = true
    stand.castShadow = true
    scene.add(stand)

    for (let i = 0; i < 18; i += 1) {
      const seat = new THREE.Mesh(standGeo, i % 2 === 0 ? seatRed : seatBlue)
      seat.scale.set(2.1, 0.35, 0.8)
      seat.position.set(-34 + i * 4, 5.05, side * (HALF_LENGTH + 9.6))
      seat.castShadow = true
      scene.add(seat)
    }
  }
}

function addPhysicsBoundaries() {
  const wallY = 0.9
  const wallH = 1.2
  const wallT = 0.45
  createFixedBox(-(HALF_WIDTH + wallT), wallY, 0, wallT, wallH, HALF_LENGTH + GOAL_DEPTH)
  createFixedBox(HALF_WIDTH + wallT, wallY, 0, wallT, wallH, HALF_LENGTH + GOAL_DEPTH)

  const segmentHalf = (HALF_WIDTH - GOAL_HALF_WIDTH) / 2
  const leftCenter = -(GOAL_HALF_WIDTH + segmentHalf)
  const rightCenter = GOAL_HALF_WIDTH + segmentHalf
  for (const side of [-1, 1]) {
    const z = side * (HALF_LENGTH + wallT)
    createFixedBox(leftCenter, wallY, z, segmentHalf, wallH, wallT)
    createFixedBox(rightCenter, wallY, z, segmentHalf, wallH, wallT)
    createFixedBox(-GOAL_HALF_WIDTH, 1.2, side * HALF_LENGTH, 0.18, 1.35, 0.18)
    createFixedBox(GOAL_HALF_WIDTH, 1.2, side * HALF_LENGTH, 0.18, 1.35, 0.18)
    createFixedBox(0, wallY, side * (HALF_LENGTH + GOAL_DEPTH), GOAL_HALF_WIDTH, wallH, wallT)
  }
}

function createFixedBox(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
  const body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z))
  physicsWorld.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz).setRestitution(0.48).setFriction(0.86),
    body,
  )
}

function createBall() {
  const group = new THREE.Group()
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f1df, roughness: 0.52, metalness: 0.02 })
  const black = new THREE.LineBasicMaterial({ color: 0x171717, transparent: true, opacity: 0.82 })
  const core = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 36, 22), white)
  core.castShadow = true
  core.receiveShadow = true
  group.add(core)

  const marks = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(BALL_RADIUS * 1.015, 2)), black)
  group.add(marks)
  return group
}

function createPlayerVisual(id: string, team: Team, local: boolean): PlayerVisual {
  const group = new THREE.Group()
  group.name = `player-${id}`

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.43, 0.78, 6, 14), kitMaterials[team])
  body.position.y = 1.02
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 18, 12),
    new THREE.MeshStandardMaterial({ color: 0xf0c89d, roughness: 0.6 }),
  )
  head.position.y = 1.79
  head.castShadow = true
  group.add(head)

  const bootMaterial = new THREE.MeshStandardMaterial({ color: 0x181b1d, roughness: 0.7 })
  for (const x of [-0.22, 0.22]) {
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.5), bootMaterial)
    boot.position.set(x, 0.12, 0.18)
    boot.castShadow = true
    group.add(boot)
  }

  const pointer = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.5, 18),
    new THREE.MeshStandardMaterial({ color: 0xf8f8f2, roughness: 0.4 }),
  )
  pointer.position.set(0, 0.22, 0.72)
  pointer.rotation.x = Math.PI / 2
  group.add(pointer)

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.9, 40), local ? localRingMaterial : remoteRingMaterial)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.045
  group.add(ring)

  scene.add(group)
  return { group, body, ring, team }
}

function setupInput() {
  window.addEventListener('keydown', (event) => {
    keys.add(event.code)
    if (event.code === 'Space') {
      event.preventDefault()
      requestKick()
    }
  })

  window.addEventListener('keyup', (event) => {
    keys.delete(event.code)
  })

  window.addEventListener('pointerdown', () => {
    requestKick()
  })

  window.addEventListener('blur', () => {
    keys.clear()
  })
}

function frame(timestamp?: number) {
  timer.update(timestamp)
  const dt = Math.min(timer.getDelta(), 0.05)
  const now = performance.now()

  if (room) {
    updateLocalPlayer(dt)
    updateSharedInputs(now)
    updateHostRole()
    resolveSlotConflict(now)
    if (isHost) updateHostPhysics(dt, now)
    updatePlayers()
    updateBall(dt)
    updateCamera(dt)
    updateHud()
  }

  renderer.render(scene, camera)
  animationId = requestAnimationFrame(frame)
}

function updateLocalPlayer(dt: number) {
  if (localPlayer.team === 'spectator') return

  const forward = tmpVec
  camera.getWorldDirection(forward)
  forward.y = 0
  if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1)
  forward.normalize()

  const right = tmpVecB
  right.crossVectors(forward, worldUp).normalize()

  const move = new THREE.Vector3()
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward)
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward)
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right)
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right)

  const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight')
  localPlayer.sprint = sprinting ? 1 : 0

  if (move.lengthSq() > 0.0001) {
    move.normalize()
    const speed = sprinting ? 10.6 : 7.0
    localPlayer.x += move.x * speed * dt
    localPlayer.z += move.z * speed * dt
    localPlayer.yaw = Math.atan2(move.x, move.z)
  }

  localPlayer.x = clamp(localPlayer.x, -HALF_WIDTH + PLAYER_RADIUS, HALF_WIDTH - PLAYER_RADIUS)
  localPlayer.z = clamp(localPlayer.z, -HALF_LENGTH + PLAYER_RADIUS, HALF_LENGTH - PLAYER_RADIUS)
  localPlayer.t = Date.now()
}

function requestKick() {
  const now = performance.now()
  if (now - lastKickAt < 230 || localPlayer.team === 'spectator') return
  const dx = latestBall.x - localPlayer.x
  const dz = latestBall.z - localPlayer.z
  if (dx * dx + dz * dz > KICK_RANGE * KICK_RANGE) return

  lastKickAt = now
  localPlayer.kick += 1
  playKickSound()
  publishLocalState()
}

function playKickSound() {
  if (!kickBuffer) return
  const sound = new THREE.Audio(listener)
  sound.setBuffer(kickBuffer)
  sound.setVolume(0.42)
  sound.play()
}

function publishLocalState() {
  if (!room || !onlineActive) return
  try {
    room.me.set({ ...localPlayer, t: Date.now() })
  } catch {
    stopOnlineUpdates()
  }
}

function updateSharedInputs(now: number) {
  if (!room) return
  const sharedBall = parseBall(room.shared.get('ball'))
  if (sharedBall && sharedBall.seq !== latestBallSeq) {
    latestBallSeq = sharedBall.seq
    latestBall = sharedBall
    ballInterpolator.push(BALL_ID, {
      x: sharedBall.x,
      y: sharedBall.y,
      z: sharedBall.z,
      yaw: 0,
    })
  }

  const sharedScore = parseScore(room.shared.get('score'))
  if (sharedScore) score = sharedScore

  if (now - lastSharedBallAt > 1500 && !sharedBall && isHost) {
    publishBallState()
  }
}

function updateHostRole() {
  if (!room) return
  const hostId = computeHostId()
  isHost = hostId === room.id

  if (isHost && !wasHost) {
    const sharedBall = parseBall(room.shared.get('ball'))
    if (sharedBall) {
      ballSeq = Math.max(ballSeq, sharedBall.seq)
      setBallPhysics(sharedBall.x, sharedBall.z, sharedBall.vx, sharedBall.vz)
    } else {
      resetBall('Kickoff')
    }
    const sharedScore = parseScore(room.shared.get('score'))
    if (sharedScore) score = sharedScore
    setShared('score', score)
    publishBallState()
  }

  wasHost = isHost
}

function updateHostPhysics(dt: number, now: number) {
  if (!room) return
  const players = getPlayerStates()
  syncPhysicsPlayers(players)

  physicsAccumulator = Math.min(physicsAccumulator + dt, 0.15)
  while (physicsAccumulator >= FIXED_STEP) {
    applyKickImpulses(players)
    physicsWorld.step()
    constrainBall()
    checkGoal()
    physicsAccumulator -= FIXED_STEP
  }

  if (now - lastSharedBallAt > 66) {
    publishBallState()
  }
}

function syncPhysicsPlayers(players: Map<string, PlayerSync>) {
  const active = new Set<string>()
  for (const [id, state] of players) {
    if (state.team === 'spectator') continue
    active.add(id)
    let entry = physicsPlayers.get(id)
    if (!entry) {
      const body = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(state.x, PLAYER_Y, state.z),
      )
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.capsule(0.42, PLAYER_RADIUS).setRestitution(0.18).setFriction(0.95),
        body,
      )
      entry = { body }
      physicsPlayers.set(id, entry)
    }
    entry.body.setNextKinematicTranslation({ x: state.x, y: PLAYER_Y, z: state.z })
  }

  for (const id of physicsPlayers.keys()) {
    if (!active.has(id)) removePhysicsPlayer(id)
  }
}

const seenKicks = new Map<string, number>()

function applyKickImpulses(players: Map<string, PlayerSync>) {
  const ballPosition = ballBody.translation()
  for (const [id, state] of players) {
    const previous = seenKicks.get(id)
    if (previous === undefined) {
      seenKicks.set(id, state.kick)
      continue
    }
    if (previous === state.kick || state.team === 'spectator') continue
    seenKicks.set(id, state.kick)

    const dx = ballPosition.x - state.x
    const dz = ballPosition.z - state.z
    const distanceSq = dx * dx + dz * dz
    if (distanceSq > KICK_RANGE * KICK_RANGE) continue

    const distance = Math.max(Math.sqrt(distanceSq), 0.001)
    const forwardX = Math.sin(state.yaw)
    const forwardZ = Math.cos(state.yaw)
    const dirX = dx / distance + forwardX * 1.25
    const dirZ = dz / distance + forwardZ * 1.25
    const len = Math.max(Math.hypot(dirX, dirZ), 0.001)
    const power = state.sprint ? 7.9 : 6.4
    ballBody.applyImpulse({ x: (dirX / len) * power, y: 0, z: (dirZ / len) * power }, true)
  }
}

function constrainBall() {
  const pos = ballBody.translation()
  const vel = ballBody.linvel()
  const speed = Math.hypot(vel.x, vel.z)
  if (speed > 18) {
    const scale = 18 / speed
    ballBody.setLinvel({ x: vel.x * scale, y: 0, z: vel.z * scale }, true)
  } else if (Math.abs(vel.y) > 0.001) {
    ballBody.setLinvel({ x: vel.x, y: 0, z: vel.z }, true)
  }

  if (Math.abs(pos.y - BALL_RADIUS) > 0.01) {
    ballBody.setTranslation({ x: pos.x, y: BALL_RADIUS, z: pos.z }, true)
  }
}

function checkGoal() {
  if (!room) return
  const pos = ballBody.translation()
  if (Math.abs(pos.x) > GOAL_HALF_WIDTH) return

  if (pos.z < -HALF_LENGTH - BALL_RADIUS) {
    score = { ...score, red: score.red + 1, last: 'Red goal' }
    setShared('score', score)
    resetBall(score.last)
  }

  if (pos.z > HALF_LENGTH + BALL_RADIUS) {
    score = { ...score, blue: score.blue + 1, last: 'Blue goal' }
    setShared('score', score)
    resetBall(score.last)
  }
}

function setBallPhysics(x: number, z: number, vx: number, vz: number) {
  ballBody.setTranslation({ x, y: BALL_RADIUS, z }, true)
  ballBody.setLinvel({ x: vx, y: 0, z: vz }, true)
  ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
}

function resetBall(label: string) {
  setBallPhysics(0, 0, 0, 0)
  score = { ...score, last: label }
  publishBallState()
}

function publishBallState() {
  if (!room) return
  const pos = ballBody.translation()
  const vel = ballBody.linvel()
  ballSeq += 1
  latestBall = {
    x: pos.x,
    y: BALL_RADIUS,
    z: pos.z,
    vx: vel.x,
    vy: 0,
    vz: vel.z,
    seq: ballSeq,
    by: room.id,
  }
  latestBallSeq = latestBall.seq
  ballInterpolator.push(BALL_ID, { x: latestBall.x, y: latestBall.y, z: latestBall.z, yaw: 0 })
  if (setShared('ball', latestBall)) {
    lastSharedBallAt = performance.now()
  }
}

function updatePlayers() {
  if (!room) return
  const states = getPlayerStates()
  const active = new Set<string>()

  const localVisual = ensurePlayerVisual(room.id, localPlayer.team, true)
  applyPlayerPose(localVisual, {
    x: localPlayer.x,
    y: localPlayer.y,
    z: localPlayer.z,
    yaw: localPlayer.yaw,
  })
  active.add(room.id)

  for (const [id, state] of states) {
    if (id === room.id) continue
    active.add(id)
    playerInterpolator.push(id, toPose(state))
    const pose = playerInterpolator.sample(id)
    if (!pose) continue
    const visual = ensurePlayerVisual(id, state.team, false)
    applyPlayerPose(visual, pose)
  }

  for (const id of playerVisuals.keys()) {
    if (!active.has(id)) removePlayerVisual(id)
  }
}

function ensurePlayerVisual(id: string, team: Team, local: boolean) {
  let visual = playerVisuals.get(id)
  if (!visual) {
    visual = createPlayerVisual(id, team, local)
    playerVisuals.set(id, visual)
  }
  if (visual.team !== team) {
    visual.body.material = kitMaterials[team]
    visual.team = team
  }
  visual.ring.visible = team !== 'spectator'
  return visual
}

function applyPlayerPose(visual: PlayerVisual, pose: RemotePose) {
  visual.group.position.set(pose.x, 0, pose.z)
  tmpQuat.setFromAxisAngle(worldUp, pose.yaw)
  visual.group.quaternion.slerp(tmpQuat, 0.42)
}

function updateBall(dt: number) {
  const previous = ballVisual.position.clone()
  if (isHost) {
    const pos = ballBody.translation()
    latestBall = {
      ...latestBall,
      x: pos.x,
      y: BALL_RADIUS,
      z: pos.z,
      vx: ballBody.linvel().x,
      vy: 0,
      vz: ballBody.linvel().z,
    }
    ballVisual.position.set(pos.x, BALL_RADIUS, pos.z)
  } else {
    const pose = ballInterpolator.sample(BALL_ID)
    if (pose) {
      ballVisual.position.lerp(new THREE.Vector3(pose.x, BALL_RADIUS, pose.z), 1 - Math.exp(-16 * dt))
      latestBall = { ...latestBall, x: ballVisual.position.x, y: BALL_RADIUS, z: ballVisual.position.z }
    } else {
      ballVisual.position.lerp(new THREE.Vector3(latestBall.x, BALL_RADIUS, latestBall.z), 1 - Math.exp(-10 * dt))
    }
  }

  const delta = ballVisual.position.clone().sub(previous)
  ballVisual.children[0].rotation.x += delta.z / BALL_RADIUS
  ballVisual.children[0].rotation.z -= delta.x / BALL_RADIUS
}

function updateCamera(dt: number) {
  const playerPosition = new THREE.Vector3(localPlayer.x, 0, localPlayer.z)
  const ballPosition = new THREE.Vector3(latestBall.x, 0, latestBall.z)
  const toBall = ballPosition.clone().sub(playerPosition)
  const ballDistance = toBall.length()
  const lookAhead = toBall.clone().clampLength(0, 16).multiplyScalar(0.35)
  const focus = playerPosition.clone().add(lookAhead).add(new THREE.Vector3(0, 1.2, 0))

  const fallbackBack = new THREE.Vector3(-Math.sin(localPlayer.yaw), 0, -Math.cos(localPlayer.yaw))
  const back = ballDistance > 1 ? playerPosition.clone().sub(ballPosition).setY(0).normalize() : fallbackBack
  const desired = focus.clone().add(back.multiplyScalar(18)).add(new THREE.Vector3(0, 20, 0))
  const response = 1 - Math.exp(-4.8 * dt)
  camera.position.lerp(desired, response)
  camera.lookAt(focus)
}

function updateHud() {
  if (!room) return
  const players = getPlayerStates()
  let red = 0
  let blue = 0
  for (const player of players.values()) {
    if (player.team === 'red') red += 1
    if (player.team === 'blue') blue += 1
  }

  const scoreKey = `${score.red}:${score.blue}:${score.last}`
  if (scoreKey !== lastScoreHud) {
    redScoreEl.textContent = String(score.red)
    blueScoreEl.textContent = String(score.blue)
    lastScoreHud = scoreKey
  }

  const teamLabel = localPlayer.team === 'spectator' ? 'Spectator' : `${capitalize(localPlayer.team)} ${localPlayer.slot}/10`
  teamBadgeEl.textContent = teamLabel
  playerCountEl.textContent = `${red + blue} / 20`
  hostBadgeEl.textContent = isHost ? 'Room lead' : 'Online'
  statusEl.textContent = score.last
}

function resolveSlotConflict(now: number) {
  if (!room || localPlayer.team === 'spectator' || now - lastSlotResolveAt < 1000) return
  lastSlotResolveAt = now

  const states = getPlayerStates()
  for (const [id, state] of states) {
    if (id === room.id) continue
    const sameSlot = state.team === localPlayer.team && state.slot === localPlayer.slot
    if (!sameSlot || id > room.id) continue

    const assigned = assignTeamAndSlot(true)
    const spawn = spawnFor(assigned.team, assigned.slot)
    localPlayer = {
      ...localPlayer,
      team: assigned.team,
      slot: assigned.slot,
      x: spawn.x,
      y: PLAYER_Y,
      z: spawn.z,
      yaw: assigned.team === 'blue' ? Math.PI : 0,
    }
    publishLocalState()
    return
  }
}

function getPlayerStates() {
  const states = new Map<string, PlayerSync>()
  if (!room) return states

  states.set(room.id, localPlayer)
  for (const [id, player] of room.players) {
    if (id === room.id) continue
    states.set(id, normalizePlayer(player.stateRaw, id))
  }
  return states
}

function assignTeamAndSlot(excludeLocal = false): { team: Team; slot: number } {
  const states = getPlayerStates()
  if (excludeLocal && room) states.delete(room.id)
  const redSlots = usedSlots(states, 'red')
  const blueSlots = usedSlots(states, 'blue')

  if (redSlots.size <= blueSlots.size && redSlots.size < 10) {
    return { team: 'red', slot: firstFreeSlot(redSlots) }
  }
  if (blueSlots.size < 10) {
    return { team: 'blue', slot: firstFreeSlot(blueSlots) }
  }
  if (redSlots.size < 10) {
    return { team: 'red', slot: firstFreeSlot(redSlots) }
  }
  return { team: 'spectator', slot: 0 }
}

function usedSlots(states: Map<string, PlayerSync>, team: Team) {
  const slots = new Set<number>()
  for (const state of states.values()) {
    if (state.team === team && state.slot >= 1 && state.slot <= 10) slots.add(state.slot)
  }
  return slots
}

function firstFreeSlot(slots: Set<number>) {
  for (let slot = 1; slot <= 10; slot += 1) {
    if (!slots.has(slot)) return slot
  }
  return 0
}

function spawnFor(team: Team, slot: number) {
  if (team === 'spectator') return { x: 0, z: HALF_LENGTH + 14 }
  const index = Math.max(slot - 1, 0)
  const col = index % 5
  const row = Math.floor(index / 5)
  const x = -20 + col * 10
  const z = team === 'red' ? 20 + row * 9 : -20 - row * 9
  return { x, z }
}

function computeHostId() {
  if (!room) return ''
  const ids = new Set<string>([room.id])
  for (const id of room.players.keys()) ids.add(id)
  return Array.from(ids).sort()[0] || room.id
}

function normalizePlayer(value: PlayerSync, id: string): PlayerSync {
  const partial = value as Partial<PlayerSync>
  return {
    x: finite(partial.x, 0),
    y: finite(partial.y, PLAYER_Y),
    z: finite(partial.z, 0),
    yaw: finite(partial.yaw, 0),
    team: normalizeTeam(partial.team),
    slot: Math.round(finite(partial.slot, 0)),
    name: typeof partial.name === 'string' ? partial.name : id.slice(0, 5),
    kick: Math.round(finite(partial.kick, 0)),
    sprint: finite(partial.sprint, 0),
    t: finite(partial.t, 0),
  }
}

function normalizeTeam(value: unknown): Team {
  if (value === 'red' || value === 'blue' || value === 'spectator') return value
  return 'spectator'
}

function toPose(state: PlayerSync): RemotePose {
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    yaw: state.yaw,
  }
}

function parseBall(value: unknown): BallSync | null {
  if (!value || typeof value !== 'object') return null
  const partial = value as Partial<BallSync>
  const seq = finite(partial.seq, -1)
  if (seq < 0) return null
  return {
    x: finite(partial.x, 0),
    y: finite(partial.y, BALL_RADIUS),
    z: finite(partial.z, 0),
    vx: finite(partial.vx, 0),
    vy: finite(partial.vy, 0),
    vz: finite(partial.vz, 0),
    seq,
    by: typeof partial.by === 'string' ? partial.by : '',
  }
}

function parseScore(value: unknown): ScoreSync | null {
  if (!value || typeof value !== 'object') return null
  const partial = value as Partial<ScoreSync>
  return {
    red: Math.max(0, Math.round(finite(partial.red, 0))),
    blue: Math.max(0, Math.round(finite(partial.blue, 0))),
    last: typeof partial.last === 'string' ? partial.last : 'Kickoff',
  }
}

function removePlayerVisual(id: string) {
  const visual = playerVisuals.get(id)
  if (!visual) return
  scene.remove(visual.group)
  playerVisuals.delete(id)
}

function removePhysicsPlayer(id: string) {
  const entry = physicsPlayers.get(id)
  if (!entry) return
  physicsWorld.removeRigidBody(entry.body)
  physicsPlayers.delete(id)
}

function setShared(key: string, value: unknown) {
  if (!room || !onlineActive) return false
  try {
    room.shared.set(key, value)
    return true
  } catch {
    stopOnlineUpdates()
    return false
  }
}

function stopOnlineUpdates() {
  onlineActive = false
  if (publishTimer) {
    window.clearInterval(publishTimer)
    publishTimer = 0
  }
  hostBadgeEl.textContent = 'Offline'
}

function finite(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}

window.addEventListener('beforeunload', () => {
  if (publishTimer) window.clearInterval(publishTimer)
  if (animationId) window.cancelAnimationFrame(animationId)
  onlineActive = false
  if (room) {
    try {
      room.leave()
    } catch {
      // The room may already be gone during browser shutdown.
    }
  }
})
