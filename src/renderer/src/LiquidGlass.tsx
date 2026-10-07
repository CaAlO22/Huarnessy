import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'

export type DisplacementMap = { url: string; specularUrl: string; width: number; height: number; rim: number }

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

// Signed distance to a rounded rectangle: negative values are inside the lens.
function roundedRectDistance(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x - width / 2) - (width / 2 - radius)
  const qy = Math.abs(y - height / 2) - (height / 2 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

function createDisplacementMap(width: number, height: number, radius: number): DisplacementMap {
  // Cap axes separately: a tall reply must not shrink its horizontal rim to
  // only a handful of pixels in the displacement bitmap.
  const pixelWidth = Math.max(2, Math.min(384, Math.round(width)))
  const pixelHeight = Math.max(2, Math.min(384, Math.round(height)))
  const canvas = document.createElement('canvas')
  canvas.width = pixelWidth
  canvas.height = pixelHeight
  const context = canvas.getContext('2d')!
  const image = context.createImageData(pixelWidth, pixelHeight)
  const specularCanvas = document.createElement('canvas')
  specularCanvas.width = pixelWidth
  specularCanvas.height = pixelHeight
  const specularContext = specularCanvas.getContext('2d')!
  const specular = specularContext.createImageData(pixelWidth, pixelHeight)
  // Bubbles can be only one line tall; keep their rim proportional.
  const rim = Math.min(80, Math.max(12, Math.min(width, height) * .16))

  for (let y = 0; y < pixelHeight; y++) {
    for (let x = 0; x < pixelWidth; x++) {
      const px = (x + .5) * width / pixelWidth
      const py = (y + .5) * height / pixelHeight
      const distance = roundedRectDistance(px, py, width, height, radius)
      const edge = clamp01(1 + distance / rim)
      const index = (y * pixelWidth + x) * 4
      let red = 128
      let green = 128
      let shine = 0
      if (edge > 0) {
        // Blend adjacent edge normals through corners. A raw SDF gradient
        // changes its nearest edge on a diagonal and creates visible seams.
        const nearX = Math.pow(clamp01(1 - Math.min(px, width - px) / rim), 1.5)
        const nearY = Math.pow(clamp01(1 - Math.min(py, height - py) / rim), 1.5)
        const nx = (px < width / 2 ? -1 : 1) * nearX
        const ny = (py < height / 2 ? -1 : 1) * nearY
        const normalLength = Math.hypot(nx, ny) || 1
        // Zero shift at both rim boundaries prevents a sharp image jump;
        // the curved lens reaches its strongest displacement in between.
        const bulge = Math.pow(Math.sin(Math.PI * edge), 1.1)
        // Sample toward the inside of the glass. Sampling outward along the
        // top edge can pull the chat pane's border into a nearby bubble.
        red = Math.round(128 - nx / normalLength * bulge * 112)
        green = Math.round(128 - ny / normalLength * bulge * 112)
        // A restrained, narrow reflection follows the computed surface normal.
        const light = Math.abs((-nx * .6 - ny * .8) / normalLength)
        if (distance <= 0) shine = Math.round((.005 + .06 * Math.pow(light, 3)) * Math.exp(-Math.pow((1 - edge) / .18, 2)) * 255)
      }
      image.data[index] = red
      image.data[index + 1] = green
      image.data[index + 2] = 128
      image.data[index + 3] = 255
      specular.data[index] = 255
      specular.data[index + 1] = 255
      specular.data[index + 2] = 255
      specular.data[index + 3] = shine
    }
  }
  context.putImageData(image, 0, 0)
  specularContext.putImageData(specular, 0, 0)
  return { url: canvas.toDataURL('image/png'), specularUrl: specularCanvas.toDataURL('image/png'), width, height, rim: Math.round(rim) }
}

export function useLiquidGlassSurface<T extends HTMLElement>(enabled: boolean): {
  ref: RefObject<T | null>
  style: CSSProperties | undefined
  filter: React.ReactElement | null
} {
  const id = `hui-liquid-${useId().replaceAll(':', '')}`
  const { ref, map } = useLiquidGlassMap<T>(enabled)
  const style = useMemo(() => enabled ? ({
    backdropFilter: `url(#${id})`,
    WebkitBackdropFilter: `url(#${id})`,
    '--hui-specular-image': map ? `url("${map.specularUrl}")` : 'none'
  }) as CSSProperties : undefined, [enabled, id, map])
  return { ref, style, filter: enabled ? <svg className="hui-liquid-filter-defs" aria-hidden="true" width="0" height="0"><defs><LiquidGlassFilter id={id} map={map} /></defs></svg> : null }
}

export function useLiquidGlassMap<T extends HTMLElement>(enabled: boolean): { ref: RefObject<T | null>; map: DisplacementMap | null } {
  const ref = useRef<T>(null)
  const [map, setMap] = useState<DisplacementMap | null>(null)

  useLayoutEffect(() => {
    if (!enabled || !ref.current) return
    const element = ref.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous = ''
    const update = (): void => {
      const width = Math.round(element.clientWidth)
      const height = Math.round(element.clientHeight)
      const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
      const key = `${width}:${height}:${radius}`
      if (width < 2 || height < 2 || key === previous) return
      previous = key
      setMap(createDisplacementMap(width, height, radius))
    }
    update()
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(update, 80)
    })
    observer.observe(element)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [enabled])

  return { ref, map }
}

export function LiquidGlassFilter({ id, map, simple = false }: { id: string; map: DisplacementMap | null; simple?: boolean }): React.ReactElement {
  const scale = map ? Math.min(64, map.rim * 1.5) : 64
  return (
    <filter id={id} data-rim={map?.rim} x="-3%" y="-3%" width="106%" height="106%" colorInterpolationFilters="sRGB">
      {map && simple ? (
        <>
          <feImage href={map.url} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="lensMap" />
          <feDisplacementMap in="SourceGraphic" in2="lensMap" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </>
      ) : map ? (
        <>
          <feImage href={map.url} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="lensMap" />
          <feDisplacementMap in="SourceGraphic" in2="lensMap" scale={scale * .82} xChannelSelector="R" yChannelSelector="G" result="redShift" />
          <feDisplacementMap in="SourceGraphic" in2="lensMap" scale={scale} xChannelSelector="R" yChannelSelector="G" result="greenShift" />
          <feDisplacementMap in="SourceGraphic" in2="lensMap" scale={scale * 1.18} xChannelSelector="R" yChannelSelector="G" result="blueShift" />
          <feColorMatrix in="redShift" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
          <feColorMatrix in="greenShift" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
          <feColorMatrix in="blueShift" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
          <feBlend in="red" in2="green" mode="screen" result="redGreen" />
          <feBlend in="redGreen" in2="blue" mode="screen" />
        </>
      ) : <feGaussianBlur in="SourceGraphic" stdDeviation="19" />}
    </filter>
  )
}
