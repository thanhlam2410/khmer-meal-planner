// Prompts + schemas for menu extraction and cross-checking.

export const CATEGORIES = [
  'chicken', 'pork', 'beef', 'duck', 'fish', 'seafood', 'egg', 'tofu',
  'vegetable', 'rice', 'noodle', 'soup', 'salad', 'snack',
  'beer', 'alcohol', 'soft_drink', 'coffee_tea', 'juice', 'water', 'dessert', 'other',
]

export const TAGS = [
  'chicken', 'vegetables', 'beer', 'spicy', 'vegetarian', 'grilled', 'fried', 'soup',
  'shared_platter', 'per_kg', 'drink', 'alcoholic',
]

export const EXTRACT_SYSTEM = `You are an expert reader of Cambodian restaurant menus. You read Khmer script (including Khmer numerals ០-៩) precisely and translate into natural English.
You transcribe exactly what is printed — never invent items or prices. If something is unreadable, say so in the "notes" field and lower "confidence".`

export const extractUserPrompt = (imageName) => `Extract EVERY menu item visible in this image (${imageName}). The photo may be rotated, glared, cropped, or show two pages.

Return ONE JSON object with exactly this shape:
{
  "restaurant": {
    "name_km": string | null,        // as printed in Khmer, if visible
    "name_en": string | null,        // as printed in Latin script, or your transliteration
    "visible": boolean               // true only if a restaurant name/logo is actually printed in THIS image
  },
  "image_quality": "good" | "fair" | "poor",
  "rotation_degrees": 0 | 90 | 180 | 270,  // how much the image is rotated from upright
  "items": [
    {
      "name_km": string,             // exact Khmer transcription as printed ("" if the item is printed only in Latin script)
      "name_printed_latin": string | null,  // any Latin-script name printed next to it (e.g. "Tiger", "Oyster")
      "name_en": string,             // natural English dish name
      "description_en": string | null,     // short English explanation of what the dish is
      "section_km": string | null,   // menu section heading as printed in Khmer
      "section_en": string | null,   // that heading in English
      "category": one of ${JSON.stringify(CATEGORIES)},   // main ingredient / type
      "tags": subset of ${JSON.stringify(TAGS)},
      "prices": [                    // one entry per printed price (sizes, can vs bottle, $ and ៛ both printed, etc.)
        {
          "price_text": string,      // EXACTLY as printed, keep Khmer numerals/symbols, e.g. "6000៛", "១២,០០០", "2.5$"
          "amount": number,          // numeric value you read, Khmer numerals converted (១២,០០០ -> 12000)
          "currency": "KHR" | "USD", // ៛ or "R" or bare thousands = KHR; $ = USD
          "variant_km": string | null,   // e.g. column header "កំប៉ុង", size "ធំ"
          "variant_en": string | null,   // e.g. "can", "bottle", "large", "half kg"
          "unit_km": string | null,      // e.g. "1ចាន"
          "unit_en": string | null       // e.g. "per plate", "per kg"
        }
      ],
      "confidence": number,          // 0-1: how sure you are about name AND price
      "notes": string | null         // anything uncertain (glare, cut off, ambiguous column)
    }
  ]
}

Rules:
- "chicken" category/tag: the dish's main protein is chicken (មាន់), including chicken feet, wings, soup with chicken.
- "vegetables" tag: the dish is mainly vegetables, or is cooked with substantial vegetables (stir-fried greens, salad, vegetable soup). Lettuce garnish alone does NOT count.
- "beer" tag + category: beer (ស្រាបៀរ) including brands like Angkor, Cambodia, Anchor, Tiger, ABC, Leo, Heineken. Beer cocktails are "alcohol".
- Items with no readable price: include them with "prices": [] and explain in notes.
- Do NOT translate or convert prices to USD yourself beyond the "amount"/"currency" fields.
- Output JSON only, no markdown.`

export const CROSSCHECK_SYSTEM = `You are a meticulous auditor verifying a data-entry job. You read Khmer script and Khmer numerals precisely. Judge only against what is visibly printed in the image.`

export const crosscheckUserPrompt = (items) => `Another model extracted the menu items below from this image. Verify each one against the image.

Extracted items (JSON):
${JSON.stringify(items, null, 1)}

Return ONE JSON object:
{
  "items": [
    {
      "id": string,                 // the id given above
      "exists": boolean,            // the item really is on this image
      "name_km_ok": boolean,        // Khmer transcription matches what is printed (minor spacing differences are OK)
      "translation_ok": boolean,    // English name is a fair translation
      "price_ok": boolean,          // every amount + currency matches the printed price for THIS item
      "category_ok": boolean,       // category/tags are reasonable (esp. chicken / vegetables / beer)
      "correct_prices": [ { "price_text": string, "amount": number, "currency": "KHR" | "USD", "variant_en": string | null } ] | null,  // only if price_ok is false
      "note": string | null
    }
  ],
  "missing_items": [ { "name_km": string, "name_en": string, "price_text": string } ],  // printed items the extraction missed
  "overall_comment": string
}
Output JSON only.`
