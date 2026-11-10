// 三维预览：把一个盒子（每一格是什么方块）画成可以拖着转、滚轮缩放、一层层剖开看的立体图。
// 手写的 WebGL，没有用任何库。数据是大脑给的（/api/drafts/model、/api/pictures/model，格式见 src/render/scene.ts）：
// 每种方块要么有贴图（在图集的第几格），要么只有颜色；玻璃和水半透明；楼梯、栅栏这类不是整块的只是画小一点。
//
// 分两半：buildMesh 把盒子变成一堆三角形（纯计算，test/viewer3d.test.ts 管着）；createViewer 管画布、镜头和那几个按钮。

/** 一个顶点 10 个数：位置 x y z，贴图坐标 u v（没有贴图时是 -1），颜色 r g b a（0–1），明暗。 */
export const FLOATS_PER_VERTEX = 10
/** 画出来的面太多时不再加（一个面 6 个顶点）：浏览器还转得动的量。 */
export const MAX_FACES = 500000

/** “调色板下标, 连续几格” → 每格一个下标。顺序是 x 最快，其次 z，最后 y。 */
export function expandRuns(scene) {
  const { x, y, z } = scene.size
  const cells = new Uint16Array(x * y * z)
  let at = 0
  for (let i = 0; i + 1 < scene.runs.length && at < cells.length; i += 2) {
    const count = Math.min(scene.runs[i + 1], cells.length - at)
    if (scene.runs[i] !== 0) cells.fill(scene.runs[i], at, at + count)
    at += count
  }
  return cells
}

// 六个面：朝哪边、四个角（从外面看：左下、右下、右上、左上）、明暗。顶面最亮，南北面次之，东西面再暗，底面最暗——和大脑画的简图一个路数。
const FACES = [
  { o: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], light: 0.62 },
  { o: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], light: 0.62 },
  { o: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], light: 1 },
  { o: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], light: 0.5 },
  { o: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], light: 0.8 },
  { o: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], light: 0.8 },
]

/** 不是整块的方块在一格里占的地方：[x0, y0, z0, x1, y1, z1]。和 src/render/views.ts 里画简图用的一致。 */
const BOXES = {
  full: [0, 0, 0, 1, 1, 1],
  slab: [0, 0, 0, 1, 0.5, 1],
  small: [0.25, 0, 0.25, 0.75, 0.5, 0.75],
  flat: [0, 0, 0, 1, 0.125, 1],
  post: [0.3, 0, 0.3, 0.7, 1, 0.7],
}

/** 贴图坐标往格子里缩一点，免得采到隔壁那张贴图的边。 */
const TILE_INSET = 0.02

/** 一段会自己变长的 Float32Array：顶点很多，用普通数组太占地方。 */
class Vertices {
  constructor() {
    this.data = new Float32Array(1 << 14)
    this.length = 0
  }
  room(count) {
    if (this.length + count <= this.data.length) return
    const bigger = new Float32Array(Math.max(this.data.length * 2, this.length + count))
    bigger.set(this.data.subarray(0, this.length))
    this.data = bigger
  }
  done() {
    return this.data.subarray(0, this.length)
  }
}

/**
 * 把盒子变成三角形。opts.cut：只画到第几层（从 0 数，默认到顶）；opts.only：只画 cut 那一层。
 * 被不透明的整块挡住的面不画；剖开以后，露出来的那一层的顶面要画。
 * 返回不透明的和半透明的两批顶点（半透明的要后画）、面数、看得见的方块数，以及是不是面太多没画全。
 */
export function buildMesh(scene, cells, opts = {}) {
  const { x: sx, y: sy, z: sz } = scene.size
  const cut = Math.max(0, Math.min(sy - 1, opts.cut ?? sy - 1))
  const only = opts.only === true
  const maxFaces = opts.maxFaces ?? MAX_FACES
  const kinds = scene.kinds
  const solid = kinds.map((k) => k !== null && k.shape === 'full' && k.alpha >= 1)
  const atlas = scene.atlas
  const shown = (y) => y <= cut && (!only || y === cut)
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz || !shown(y) ? 0 : cells[(y * sz + z) * sx + x])
  const opaque = new Vertices()
  const transparent = new Vertices()
  let faces = 0
  let blocks = 0
  let truncated = false
  const corner = [0, 0, 0]

  const quad = (x, y, z, kind, face, box) => {
    if (faces >= maxFaces) {
      truncated = true
      return
    }
    faces++
    const up = face.o[1] === 1
    const glass = kind.alpha < 1
    // 顶面有自己的贴图就用它的；底面和侧面用同一张
    const tile = atlas ? (up ? (kind.texTop ?? kind.tex) : kind.tex) : undefined
    const flat = up ? kind.top : kind.side
    const tint = up && kind.texTop !== undefined ? kind.tintTop : up ? (kind.tintTop ?? kind.tint) : kind.tint
    // 有贴图：颜色是给贴图染的色（不染就是白）；半透明的方块带的是它自己的颜色，贴图镂空的地方露出来。没贴图：就是这个面的颜色
    const color = tile === undefined || glass ? flat : (tint ?? [255, 255, 255])
    const out = glass ? transparent : opaque
    out.room(6 * FLOATS_PER_VERTEX)
    const quadStart = out.length
    for (let n = 0; n < 4; n++) {
      const c = face.c[n]
      for (let axis = 0; axis < 3; axis++) corner[axis] = box[axis] + c[axis] * (box[axis + 3] - box[axis])
      let u = -1
      let v = -1
      if (tile !== undefined) {
        // 贴图在这个面上的朝向：从外面看，上面是上，左右不反
        const across = face.o[0] === 1 ? 1 - corner[2] : face.o[0] === -1 ? corner[2] : face.o[2] === -1 ? 1 - corner[0] : corner[0]
        const down = face.o[1] === 1 ? corner[2] : face.o[1] === -1 ? 1 - corner[2] : 1 - corner[1]
        u = ((tile % atlas.columns) + TILE_INSET + across * (1 - 2 * TILE_INSET)) / atlas.columns
        v = (Math.floor(tile / atlas.columns) + TILE_INSET + down * (1 - 2 * TILE_INSET)) / atlas.rows
      }
      const d = out.data
      let o = quadStart + n * FLOATS_PER_VERTEX
      d[o++] = x + corner[0]
      d[o++] = y + corner[1]
      d[o++] = z + corner[2]
      d[o++] = u
      d[o++] = v
      d[o++] = color[0] / 255
      d[o++] = color[1] / 255
      d[o++] = color[2] / 255
      d[o++] = kind.alpha
      d[o] = face.light
    }
    // 四个角 → 两个三角形（0 1 2、0 2 3）：把第 2、3 个角各再抄一份
    const d = out.data
    d.copyWithin(quadStart + 4 * FLOATS_PER_VERTEX, quadStart + 2 * FLOATS_PER_VERTEX, quadStart + 4 * FLOATS_PER_VERTEX)
    d.copyWithin(quadStart + 3 * FLOATS_PER_VERTEX, quadStart, quadStart + FLOATS_PER_VERTEX)
    out.length = quadStart + 6 * FLOATS_PER_VERTEX
  }

  for (let y = 0; y <= cut; y++) {
    if (!shown(y)) continue
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const cell = cells[(y * sz + z) * sx + x]
        const kind = cell === 0 ? null : kinds[cell]
        if (!kind) continue
        blocks++
        const box = BOXES[kind.shape] ?? BOXES.full
        if (box !== BOXES.full) {
          for (const face of FACES) quad(x, y, z, kind, face, box)
          continue
        }
        for (const face of FACES) {
          const neighbor = at(x + face.o[0], y + face.o[1], z + face.o[2])
          // 对面是不透明的整块，或者是同一种半透明方块（一池水中间的面）：这个面看不见
          if (neighbor !== 0 && (solid[neighbor] || neighbor === cell)) continue
          quad(x, y, z, kind, face, box)
        }
      }
    }
  }
  return { opaque: opaque.done(), transparent: transparent.done(), faces, blocks, truncated }
}

// 画出来的顺序是 0 1 2 0 2 3：上面先写了 0 1 2 3，再挪成 0 1 2 | 0 2 3
// （copyWithin 第一次把 2、3 挪到 4、5 的位置，第二次把 0 抄到 3 的位置。）

// ── 镜头 ──

function multiply(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** 绕着 target 转的镜头：angle 是水平转了多少（0 在东边，π/2 在南边），elevation 是抬多高，distance 是离多远。 */
export function cameraMatrix(camera, aspect) {
  const near = 0.3
  const far = 4000
  const f = 1 / Math.tan(0.7 / 2)
  const projection = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0])
  const t = camera.target
  const flat = Math.cos(camera.elevation) * camera.distance
  const eye = [t[0] + flat * Math.cos(camera.angle), t[1] + Math.sin(camera.elevation) * camera.distance, t[2] + flat * Math.sin(camera.angle)]
  const z = normalize([eye[0] - t[0], eye[1] - t[1], eye[2] - t[2]])
  const x = normalize(cross([0, 1, 0], z))
  const y = cross(z, x)
  const view = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
  return multiply(projection, view)
}

// ── 画 ──

const VERTEX_SHADER = `
attribute vec3 p; attribute vec2 uv; attribute vec4 c; attribute float l;
uniform mat4 m;
varying vec2 vUv; varying vec4 vC; varying float vL;
void main() { gl_Position = m * vec4(p, 1.0); vUv = uv; vC = c; vL = l; }`

// 不透明的：贴图乘上染色，贴图镂空的地方露出暗一点的底色。半透明的：贴图有的地方显贴图，没有的地方是方块自己的颜色。
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D atlas; uniform float glass;
varying vec2 vUv; varying vec4 vC; varying float vL;
void main() {
  vec3 rgb = vC.rgb; float a = vC.a;
  if (vUv.x >= 0.0) {
    vec4 t = texture2D(atlas, vUv);
    if (glass > 0.5) { rgb = mix(vC.rgb, t.rgb, t.a); a = mix(vC.a, 0.92, t.a); }
    else { rgb = mix(vC.rgb * 0.55, t.rgb * vC.rgb, t.a); }
  }
  gl_FragColor = vec4(rgb * vL, glass > 0.5 ? a : 1.0);
}`

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else node[key] = value
  }
  node.append(...children)
  return node
}

/**
 * 在 root 里放一个三维预览。scene 是大脑给的那份数据。返回 { destroy() }；浏览器开不了 WebGL 时返回 null（root 里写着原因）。
 */
export function createViewer(root, scene) {
  const canvas = el('canvas', { class: 'viewer3d' })
  const gl = canvas.getContext('webgl', { antialias: true })
  if (!gl) {
    root.replaceChildren(el('p', { class: 'muted', text: '这个浏览器开不了 WebGL，三维预览用不了；看下面大脑画的图。' }))
    return null
  }
  const { x: W, y: H, z: L } = scene.size
  const cells = expandRuns(scene)
  // 图集那张图到手之前先按颜色画，到了再换成贴图（不然会先闪一下白的）
  const flat = { ...scene, atlas: undefined }
  let model = flat
  const state = { cut: H - 1, only: false }
  const camera = { angle: Math.PI / 4, elevation: 0.6, distance: 10, target: [W / 2, H / 2, L / 2] }
  // 离多远正好把整个盒子看全（视角大约 40 度）
  const fit = () => Math.max(Math.max(W, L) * 1.5 + 4, H * 2 + 4)
  camera.distance = fit()

  // 着色器
  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed')
    return shader
  }
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  gl.useProgram(program)
  const attributes = [
    ['p', 3, 0],
    ['uv', 2, 3],
    ['c', 4, 5],
    ['l', 1, 9],
  ].map(([name, size, offset]) => ({ at: gl.getAttribLocation(program, name), size, offset }))
  const matrixAt = gl.getUniformLocation(program, 'm')
  const glassAt = gl.getUniformLocation(program, 'glass')

  // 贴图：先放一个白点，图集到了再换上
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
  for (const [name, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ]) {
    gl.texParameteri(gl.TEXTURE_2D, name, value)
  }

  let destroyed = false
  let opaque
  let transparent
  // 地上两条线：红的朝东（+x），蓝的朝南（+z），从西北角出发
  const axes = gl.createBuffer()
  const line = (x, z, r, g, b) => [-0.3, 0, -0.3, -1, -1, r, g, b, 1, 1, x, 0, z, -1, -1, r, g, b, 1, 1]
  gl.bindBuffer(gl.ARRAY_BUFFER, axes)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...line(W + 1.5, -0.3, 0.86, 0.15, 0.15), ...line(-0.3, L + 1.5, 0.15, 0.3, 0.9)]), gl.STATIC_DRAW)

  const upload = (old, data) => {
    if (old) gl.deleteBuffer(old.buffer)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    return { buffer, count: data.length / FLOATS_PER_VERTEX }
  }
  const bind = (buffer) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    for (const a of attributes) {
      gl.enableVertexAttribArray(a.at)
      gl.vertexAttribPointer(a.at, a.size, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, a.offset * 4)
    }
  }

  const draw = () => {
    if (destroyed || !opaque) return
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(canvas.clientWidth * scale))
    const height = Math.max(1, Math.round(canvas.clientHeight * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.clearColor(0.93, 0.95, 0.97, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.uniformMatrix4fv(matrixAt, false, cameraMatrix(camera, width / height))
    gl.disable(gl.BLEND)
    gl.depthMask(true)
    gl.uniform1f(glassAt, 0)
    bind(opaque.buffer)
    gl.drawArrays(gl.TRIANGLES, 0, opaque.count)
    bind(axes)
    gl.drawArrays(gl.LINES, 0, 4)
    // 半透明的后画，不写深度：玻璃后面的东西已经画好了
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)
    gl.uniform1f(glassAt, 1)
    bind(transparent.buffer)
    gl.drawArrays(gl.TRIANGLES, 0, transparent.count)
    gl.depthMask(true)
  }

  // 工具条
  const status = el('span', { class: 'muted' })
  const where = el('span', { class: 'muted' })
  const slider = el('input', { type: 'range', min: 0, max: H - 1, step: 1, value: H - 1 })
  slider.setAttribute('aria-label', '显示到第几层')
  const onlyBox = el('input', { type: 'checkbox' })
  const rebuild = () => {
    const mesh = buildMesh(model, cells, state)
    opaque = upload(opaque, mesh.opaque)
    transparent = upload(transparent, mesh.transparent)
    const y = scene.origin.y + state.cut
    where.textContent = `${state.only ? '只看' : '显示到'}第 ${state.cut + 1} / ${H} 层${scene.origin.y !== 0 ? `（y=${y}）` : ''}`
    status.textContent = `看得见 ${mesh.blocks.toLocaleString('zh-CN')} 个方块${mesh.truncated ? '；面太多，没有画全，把层数调低一些' : ''}`
    draw()
  }
  slider.addEventListener('input', () => {
    state.cut = Number(slider.value)
    rebuild()
  })
  onlyBox.addEventListener('change', () => {
    state.only = onlyBox.checked
    rebuild()
  })
  const preset = (label, apply) => {
    const button = el('button', { type: 'button', class: 'small', text: label })
    button.addEventListener('click', () => {
      state.only = false
      onlyBox.checked = false
      camera.angle = Math.PI / 4
      camera.distance = fit()
      apply()
      slider.value = String(state.cut)
      rebuild()
    })
    return button
  }
  const toolbar = el(
    'div',
    { class: 'row' },
    preset('完整外观', () => {
      state.cut = H - 1
      camera.elevation = 0.6
    }),
    preset('剖开看里面', () => {
      // 去掉上面一半，镜头抬高一些往里看
      state.cut = Math.max(0, Math.ceil(H / 2) - 1)
      camera.elevation = 1.0
    }),
    preset('从正上方看', () => {
      state.cut = H - 1
      camera.angle = Math.PI / 2
      camera.elevation = 1.5
    }),
    slider,
    where,
    el('label', { class: 'check' }, onlyBox, ' 只看这一层'),
    status,
  )
  const hintText = (textured) => `拖动旋转，滚轮缩放。地上红线朝东，蓝线朝南。${textured ? '' : '没有方块贴图，按颜色画。'}非整块的方块（楼梯、栅栏、火把……）只是画小一点。`
  const hint = el('p', { class: 'hint', text: hintText(scene.atlas !== undefined) })
  root.replaceChildren(toolbar, canvas, hint)

  // 拖动、滚轮
  let last = null
  canvas.addEventListener('pointerdown', (ev) => {
    last = [ev.clientX, ev.clientY]
    canvas.setPointerCapture(ev.pointerId)
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (!last) return
    camera.angle -= (ev.clientX - last[0]) * 0.008
    camera.elevation = Math.max(0.05, Math.min(1.5, camera.elevation + (ev.clientY - last[1]) * 0.006))
    last = [ev.clientX, ev.clientY]
    draw()
  })
  const release = () => (last = null)
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      camera.distance = Math.max(3, Math.min(2000, camera.distance * Math.exp(ev.deltaY * 0.001)))
      draw()
    },
    { passive: false },
  )
  const resized = new ResizeObserver(draw)
  resized.observe(canvas)

  // 图集到了换上贴图重画一遍；到不了就一直按颜色画
  if (scene.atlas) {
    const image = new Image()
    image.onload = () => {
      if (destroyed) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      model = scene
      rebuild()
    }
    image.onerror = () => {
      if (!destroyed) hint.textContent = hintText(false)
    }
    image.src = scene.atlas.url
  }
  rebuild()

  return {
    destroy() {
      destroyed = true
      resized.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
