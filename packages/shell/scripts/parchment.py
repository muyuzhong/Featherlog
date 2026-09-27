# Procedural parchment: a tileable surface per palette plus an edge-burn overlay
# that is stretched to whatever the sheet's size is. Run via gen-textures.sh.
import sys
out = sys.argv[1]  # directory for the generated SVGs
rgb = lambda h: tuple(int(h[i:i+2], 16) / 255 for i in (1, 3, 5))

def surface(name, light, cloud, deep, seed=3, fine=.12, wave=.22, clouds=.55):
    lr, lg, lb = rgb(light); cr, cg, cb = rgb(cloud); dr, dg, db = rgb(deep)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <filter id="base" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency=".0032" numOctaves="4" stitchTiles="stitch" seed="{seed}"/>
    <feColorMatrix values="{dr-lr:.3f} 0 0 0 {lr:.3f}  {dg-lg:.3f} 0 0 0 {lg:.3f}  {db-lb:.3f} 0 0 0 {lb:.3f}  0 0 0 0 1"/>
    <feComponentTransfer><feFuncR type="gamma" exponent="1.8"/><feFuncG type="gamma" exponent="1.8"/><feFuncB type="gamma" exponent="1.8"/></feComponentTransfer>
  </filter>
  <filter id="clouds" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency=".0075" numOctaves="4" stitchTiles="stitch" seed="{seed+7}"/>
    <feColorMatrix values="0 0 0 0 {cr:.3f}  0 0 0 0 {cg:.3f}  0 0 0 0 {cb:.3f}  1.9 0 0 0 -.92"/>
    <feGaussianBlur stdDeviation="10"/>
  </filter>
  <filter id="wave" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency=".009" numOctaves="3" stitchTiles="stitch" seed="{seed+3}" result="n"/>
    <feDiffuseLighting in="n" surfaceScale="4.5" diffuseConstant="1" lighting-color="#fff"><feDistantLight azimuth="225" elevation="62"/></feDiffuseLighting>
    <feGaussianBlur stdDeviation="1.2"/>
  </filter>
  <filter id="fine" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="2" stitchTiles="stitch" seed="{seed+4}" result="n"/>
    <feDiffuseLighting in="n" surfaceScale=".7" diffuseConstant="1" lighting-color="#fff"><feDistantLight azimuth="225" elevation="65"/></feDiffuseLighting>
  </filter>
  <filter id="flecks" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="2" stitchTiles="stitch" seed="{seed+9}"/>
    <feColorMatrix values="0 0 0 0 .55  0 0 0 0 .38  0 0 0 0 .18  4 0 0 0 -2.75"/>
    <feGaussianBlur stdDeviation=".6"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#base)"/>
  <rect width="100%" height="100%" filter="url(#clouds)" opacity="{clouds}"/>
  <rect width="100%" height="100%" filter="url(#flecks)" opacity=".12"/>
  <rect width="100%" height="100%" filter="url(#wave)" style="mix-blend-mode:multiply" opacity="{wave}"/>
  <rect width="100%" height="100%" filter="url(#fine)" style="mix-blend-mode:multiply" opacity="{fine}"/>
</svg>'''
    open(f'{out}/{name}.svg', 'w').write(svg)

surface('parchment-golden', '#f5e5c0', '#cfa564', '#ead19c')            # default: golden scroll
surface('parchment-vellum', '#f7ebcf', '#d9b980', '#efdcb2', seed=6)    # paler vellum
surface('parchment-aged', '#f2ddb0', '#c3914c', '#e3c186', seed=11)   # aged, warmer

burn = '''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="71%">
      <stop offset=".5" stop-color="#8a5420" stop-opacity="0"/>
      <stop offset=".78" stop-color="#8a5420" stop-opacity=".2"/>
      <stop offset=".93" stop-color="#6e3f14" stop-opacity=".5"/>
      <stop offset="1" stop-color="#4a2a0c" stop-opacity=".78"/>
    </radialGradient>
    <filter id="warp" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency=".005 .007" numOctaves="4" seed="21" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="150"/>
      <feGaussianBlur stdDeviation="4"/>
    </filter>
    <filter id="rim"><feTurbulence type="fractalNoise" baseFrequency=".03" numOctaves="3" seed="8" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="8"/><feGaussianBlur stdDeviation="7"/></filter>
  </defs>
  <rect x="-80" y="-80" width="1160" height="1160" fill="url(#g)" filter="url(#warp)"/>
  <rect x="2" y="2" width="996" height="996" fill="none" stroke="#4a2a0c" stroke-width="10" stroke-opacity=".28" filter="url(#rim)"/>
</svg>'''
open(f'{out}/parchment-burn.svg', 'w').write(burn)
