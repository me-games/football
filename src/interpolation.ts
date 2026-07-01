const RENDER_DELAY_MS = 100
const BUFFER_MS = 1000

export type RemotePose = {
  x: number
  y: number
  z: number
  yaw: number
}

type Snapshot = {
  t: number
  v: RemotePose
}

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k
}

function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}

export class RemoteInterpolator {
  private buffers = new Map<string, Snapshot[]>()

  push(id: string, v: RemotePose, now = performance.now()) {
    let buffer = this.buffers.get(id)
    if (!buffer) {
      buffer = []
      this.buffers.set(id, buffer)
    }

    const last = buffer[buffer.length - 1]
    if (
      last &&
      last.v.x === v.x &&
      last.v.y === v.y &&
      last.v.z === v.z &&
      last.v.yaw === v.yaw
    ) {
      return
    }

    buffer.push({ t: now, v })
    const cutoff = now - BUFFER_MS
    while (buffer.length > 2 && buffer[0].t < cutoff) buffer.shift()
  }

  sample(id: string, now = performance.now()): RemotePose | null {
    const buffer = this.buffers.get(id)
    if (!buffer || buffer.length === 0) return null

    const target = now - RENDER_DELAY_MS
    if (buffer.length === 1 || target <= buffer[0].t) return buffer[0].v
    if (target >= buffer[buffer.length - 1].t) return buffer[buffer.length - 1].v

    for (let i = 0; i < buffer.length - 1; i += 1) {
      const a = buffer[i]
      const b = buffer[i + 1]
      if (target >= a.t && target <= b.t) {
        const k = (target - a.t) / (b.t - a.t || 1)
        return {
          x: lerp(a.v.x, b.v.x, k),
          y: lerp(a.v.y, b.v.y, k),
          z: lerp(a.v.z, b.v.z, k),
          yaw: lerpAngle(a.v.yaw, b.v.yaw, k),
        }
      }
    }

    return buffer[buffer.length - 1].v
  }

  remove(id: string) {
    this.buffers.delete(id)
  }
}
