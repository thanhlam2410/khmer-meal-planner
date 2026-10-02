import type { MenuData } from '../optimizer/types.ts'

// public/menus.json is a copy of data/menus.json (npm predev/prebuild).
let cached: Promise<MenuData> | null = null

export function loadMenus(): Promise<MenuData> {
  cached ??= fetch('/menus.json').then((r) => {
    if (!r.ok) throw new Error(`Could not load menu data (${r.status})`)
    return r.json()
  })
  return cached
}
