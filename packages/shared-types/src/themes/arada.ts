import { DEFAULT_BRAND } from '../brand'
import type { ThemeDefinition } from './types'

export const arada: ThemeDefinition = {
  id: 'arada',
  name: 'Arada',
  defaultTokens: DEFAULT_BRAND.tokens,
  typography: {
    ui: "'Barlow Condensed', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    heading: "'Oswald', system-ui, sans-serif",
    googleHref:
      'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
    baseSize: '16px',
  },
  density: {
    utilH: '64px',
    navH: '50px',
    rowH: '44px',
    controlH: '44px',
    inputH: '44px',
    railW: '0px',
    asideW: '0px',
    radiusSm: '6px',
    radiusMd: '12px',
    radiusLg: '16px',
    borderW: '1px',
  },
}
