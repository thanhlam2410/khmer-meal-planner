import type { Plan, PlanResult } from '../optimizer/planMeal.ts'

const usd = (x: number) => `$${x.toFixed(2)}`

function OnePlan({ plan, label, primary }: { plan: Plan; label: string; primary?: boolean }) {
  return (
    <div className={`plan ${primary ? 'best' : ''} ${plan.within_budget ? '' : 'over'}`}>
      <div className="plan-head">
        <div>
          <div className="plan-label">{label}</div>
          <div className="plan-name">
            {plan.restaurants_count === 1 ? plan.stops[0].restaurant.name_en : `${plan.restaurants_count} restaurants`}
          </div>
          {plan.restaurants_count === 1 && plan.stops[0].restaurant.name_km && <div className="km">{plan.stops[0].restaurant.name_km}</div>}
        </div>
        <div className="plan-total">
          {usd(plan.total_usd)}
          {plan.leftover_usd != null && (
            <span className={plan.within_budget ? '' : 'over-text'}>
              {plan.within_budget ? `${usd(plan.leftover_usd)} left` : `${usd(plan.over_budget_by_usd)} over budget`}
            </span>
          )}
        </div>
      </div>
      {plan.stops.map((stop) => (
        <div className="stop" key={stop.restaurant.id}>
          {plan.restaurants_count > 1 && (
            <div className="stop-head">
              📍 {stop.restaurant.name_en}
              {stop.restaurant.name_km && <span className="km-inline"> {stop.restaurant.name_km}</span>}
              <span className="stop-sub">{usd(stop.subtotal_usd)}</span>
            </div>
          )}
          <ul className="plan-lines">
            {stop.lines.map((l) => (
              <li key={`${l.item_id}-${l.price_text}`}>
                <span className="qty">{l.qty}×</span>
                <span className="dish">
                  <span title={l.kind}>{l.kind === 'beverage' ? '🥤 ' : '🍽️ '}</span>
                  {l.name_en}
                  {l.variant && <em> · {l.variant}</em>}
                  {l.name_km && <span className="km">{l.name_km}</span>}
                </span>
                <span className="price">
                  {usd(l.subtotal_usd)}
                  <span className="printed" title={`Printed on menu (${l.source_image})`}>{l.price_text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {plan.warnings.filter((w) => !w.startsWith('Over budget')).length > 0 && (
        <div className="plan-warn">⚠️ {plan.warnings.filter((w) => !w.startsWith('Over budget')).join(' ')}</div>
      )}
    </div>
  )
}

export function PlanCards({ result }: { result: PlanResult }) {
  if (!result.best) {
    return (
      <div className="plan none">
        <div className="plan-name">No plan found</div>
        {result.notes.map((n) => (
          <div key={n} className="near">{n}</div>
        ))}
      </div>
    )
  }
  return (
    <div className="plans">
      <OnePlan
        plan={result.best}
        label={
          !result.best.within_budget && result.budget_usd != null
            ? `Best plan · over your ${usd(result.budget_usd)} budget`
            : result.style === 'premium'
              ? 'Best spread for your budget'
              : 'Best plan'
        }
        primary
      />
      {result.within_budget_option && (
        <OnePlan plan={result.within_budget_option} label={`Within budget · ${result.within_budget_option.restaurants_count} restaurants`} />
      )}
      {result.alternatives.slice(0, 2).map((p, i) => (
        <OnePlan key={i} plan={p} label="Alternative" />
      ))}
    </div>
  )
}
