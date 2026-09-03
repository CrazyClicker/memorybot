# Domain: «Прилавок»

Fictional e-commerce platform for small merchants on the Russian market. Every name below is
invented; no real brands, products or laws are referenced by name. Content (wiki, tickets,
notes) is Russian; code and docs are English.

## Product

- **«Прилавок»** (`prilavok`) — the platform: storefront, catalogue, orders, payments, delivery.
- Tariffs: «Старт» (базовый), «Бизнес» (расширенный: API, вебхуки, приоритетная поддержка).
- Admin panel = «панель управления»; storefront = «витрина».

## Integrations (fictional)

| Name | Role | Facts the wiki documents |
|---|---|---|
| «Оплатим» | card acquiring + QR payments | one-stage and two-stage (hold) payments; hold auto-cancels after 7 days; payouts T+2 daily or weekly |
| «Курьерика» | courier delivery | delivery zones, tariffs by zone, pickup points |
| «Чек-Онлайн» | cloud cash register, fiscal receipts | receipts issued on payment and on refund |

## Names that live only in scenarios (never in the wiki)

- «СкладУчёт» — a merchant's desktop inventory tool that exports CSV.
- Merchants (eval-world ids): `dom_i_sad` «Дом и сад» (товары для дома, «Бизнес»), `velo_dvor` «ВелоДвор» (велозапчасти, «Старт»), `kofe_tochka` «Кофе-точка» (обжарщик кофе, «Старт»), `lavanda` «Лаванда» (косметика ручной работы, «Бизнес»).
- Engineers: `eng.oleg`, `eng.dasha`.

## Support model

First-line agent answers from the wiki and memory; engineers take escalations, reply to the
customer and may leave a coach note. Escalation rules are the wiki page
`pravila-podderzhki` with ids `P-001`…`P-007`; the agent's system prompt points at it.

## Wiki pages

| slug | title |
|---|---|
| `nachalo-raboty` | Начало работы |
| `tarify-i-oplata` | Тарифы и оплата подписки |
| `platezhi-i-vyplaty` | Платежи и выплаты |
| `dostavka` | Доставка и зоны |
| `nalogi-i-cheki` | Чеки и налоги |
| `import-eksport-csv` | Импорт и экспорт товаров (CSV) |
| `domeny-i-ssl` | Домены и SSL |
| `zakazy-i-vozvraty` | Заказы и возвраты |
| `skidki-i-promokody` | Скидки и промокоды |
| `integracii-api` | Интеграции: API и вебхуки |
| `pravila-podderzhki` | Правила поддержки: когда эскалировать |

Facts deliberately absent from the wiki are listed in `wiki/README.md` and come from the
`knowledge` blocks of `evals/scenarios/*.yaml`.
