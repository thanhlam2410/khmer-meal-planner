// Shape of data/menus.json (produced by scripts/extraction/extract.py).

export type Price = {
  price_text: string
  amount: number | null
  currency: 'KHR' | 'USD'
  price_usd: number | null
  variant_en: string | null
  variant_km: string | null
  unit_en: string | null
  unit_km: string | null
  flags: string[]
}

export type CrossCheck = {
  verdict: 'agree' | 'disagree' | 'not_returned'
  price_ok?: boolean | null
  exists?: boolean | null
  category_ok?: boolean | null
  note?: string | null
} | null

export type MenuItem = {
  id: string
  name_en: string | null
  name_km: string | null
  name_printed_latin: string | null
  description_en: string | null
  section_en: string | null
  kind?: 'food' | 'beverage'
  category: string
  tags: string[]
  prices: Price[]
  min_price_usd: number | null
  confidence: number | null
  notes: string | null
  source_image: string
  crosscheck: CrossCheck
}

export type Restaurant = {
  id: string
  name_en: string
  name_km: string | null
  items: MenuItem[]
}

export type MenuData = {
  meta: { riel_per_usd: number; restaurants: number; items: number; generated_at: string }
  restaurants: Restaurant[]
}
