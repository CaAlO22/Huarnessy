import { useEffect, useRef } from 'react'

const vertexSource = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`

const fragmentSource = `
precision highp float;
varying vec2 uv;
uniform float time;
uniform float aspect;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x);
  float b = mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), f.x);
  return mix(a, b, f.y);
}

void main() {
  vec2 p = vec2(uv.x * aspect, uv.y) * 2.8;
  vec2 warp = vec2(
    noise(p * 0.66 + vec2(time * 0.12, -time * 0.07)),
    noise(p * 0.72 + vec2(8.3 - time * 0.09, time * 0.11 - 4.7))
  );
  p += (warp - 0.5) * 0.9;
  float broad = noise(p + vec2(time * 0.16, -time * 0.04));
  float detail = noise(p * 2.15 + vec2(-time * 0.11, time * 0.14));
  float fine = noise(p * 4.4 + vec2(time * 0.08, time * 0.10));
  float mottling = broad * 0.62 + detail * 0.29 + fine * 0.09;
  float gray = smoothstep(0.27, 0.78, mottling) * 0.75;
  vec3 black = vec3(0.034, 0.038, 0.046);
  vec3 charcoal = vec3(0.16, 0.17, 0.18);
  gl_FragColor = vec4(mix(black, charcoal, gray), 1.0);
}`

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

export function MottledBackground(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })
    if (!gl) return
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex)
      if (fragment) gl.deleteShader(fragment)
      return
    }
    const program = gl.createProgram()
    const buffer = gl.createBuffer()
    if (!program || !buffer) {
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      if (program) gl.deleteProgram(program)
      if (buffer) gl.deleteBuffer(buffer)
      return
    }
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      return
    }
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const timeUniform = gl.getUniformLocation(program, 'time')
    const aspectUniform = gl.getUniformLocation(program, 'aspect')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    let frame = 0
    let lastFrame = 0
    let elapsed = 0

    const render = (): void => {
      const width = canvas.parentElement?.clientWidth ?? window.innerWidth
      const height = canvas.parentElement?.clientHeight ?? window.innerHeight
      if (!width || !height) return
      // Soft mottling needs less detail than text; cap fill rate while keeping
      // the backdrop smooth on high DPI screens.
      const scale = 0.65
      const pixelWidth = Math.max(1, Math.round(width * scale))
      const pixelHeight = Math.max(1, Math.round(height * scale))
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
        gl.viewport(0, 0, pixelWidth, pixelHeight)
      }
      gl.uniform1f(timeUniform, elapsed)
      gl.uniform1f(aspectUniform, width / height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const active = (): boolean => visible && !document.hidden && !motion.matches
    const tick = (now: number): void => {
      frame = 0
      if (!active()) return
      if (now - lastFrame >= 40) {
        elapsed += Math.min(now - (lastFrame || now), 80) / 1000
        lastFrame = now
        render()
      }
      frame = requestAnimationFrame(tick)
    }
    const sync = (): void => {
      if (active()) {
        lastFrame = 0
        if (!frame) frame = requestAnimationFrame(tick)
      } else {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        render()
      }
    }
    const resize = new ResizeObserver(render)
    resize.observe(canvas.parentElement ?? canvas)
    const intersection = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true
      sync()
    })
    intersection.observe(canvas)
    document.addEventListener('visibilitychange', sync)
    motion.addEventListener('change', sync)
    render()
    sync()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', sync)
      motion.removeEventListener('change', sync)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }, [])

  return <canvas ref={canvasRef} />
}
