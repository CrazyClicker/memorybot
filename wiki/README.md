# Wiki «Прилавок»

Help-center pages the support agent can read. Served through the page index (slug, title,
summary in the system prompt) and the `read_page(slug)` tool; see `DOMAIN.md` for the page
list and names. Content is Russian. Each page starts with frontmatter `slug`, `title`,
`summary`.

## The leak rule

Evals measure memory only if the wiki does not already contain the answer. Every knowledge
item (`K1`, `K2`, …) of every scenario in `evals/scenarios/` is therefore **deliberately
absent** from these pages, in any wording. When you add a scenario, add its items below.
When you edit a page, run the leak lint:

```
pnpm eval lint-wiki      # runs every scenario with engine: none; every `uses:` must fail
```

A `uses:` check that passes under `none` means the fact leaked into the wiki. Fix the wiki,
not the scenario. Checks after a `wiki_update` step that promoted the item are exempt.

## Facts deliberately absent

### `csv-import-dropped-rows`

- **K1 personal, «Дом и сад».** Выгружает каталог из «СкладУчёт»: UTF-8 с BOM, разделитель «;», артикулы с ведущими нулями, sku в кавычках, импорт по понедельникам. The name «СкладУчёт» appears nowhere in the wiki.
- **K2 undocumented, product.** BOM в начале файла ломает распознавание заголовка sku; существующие товары обновляются по совпадению названия; новые строки без sku пропускаются молча и не попадают в отчёт. The wiki says only: products are matched by `sku`, errors are listed in the report.
- **K3 temporal, «Дом и сад», until 2026-09-10.** 37 товаров загружены вручную; до релиза 10 сентября сохранять «UTF-8 без BOM»; после релиза BOM удаляется автоматически и пропущенные строки попадают в отчёт. No release dates or upcoming fixes anywhere in the wiki.

### `setup-from-the-question`

- **K1 personal, «Кофе-точка».** Использует двухстадийную оплату: холд при заказе, списание подтверждают вручную после обжарки; обжаривают под заказ раз в неделю по пятницам. The wiki documents two-stage mode and the 7-day hold generally, never which merchant uses it or why.
- **K2 personal, «Кофе-точка».** Доставляет только по Томской области: одна зона («Курьерика») плюс самовывоз из цеха в Томске; заказы из других регионов не принимает. The wiki explains how to restrict delivery to a region, never which merchant did. No place names anywhere in the wiki.

### `payment-provider-incident`

- **K1 temporal, shared, 2026-09-05 12:00–18:00.** «Оплатим» не проводит платежи по картам ни у одного магазина, покупатели видят «платёж отклонён»; восстановление к 18:00; оплата по QR работает. No incident, outage, date or recovery time is mentioned in the wiki; P-007 only says how known incidents are communicated.
- **K2 personal, «Кофе-точка».** Заказы 1152, 1153 и 1155 в «Ожидает оплаты»; по заказу 1153 списание без оплаты заказа, случай ведёт eng.dasha. No order numbers or engineer names anywhere in the wiki.

## Facts that must be present (baselines the scenarios rely on)

- CSV: UTF-8, delimiter `,` or `;` detected from the first line, required columns `sku`, `name`, `price`, `description` up to 5000 characters, 10 000 rows per import, existing products updated by `sku`, errors listed in the import report.
- Payments: cards and QR via «Оплатим»; one-stage and two-stage mode; a hold is cancelled automatically after 7 days and cannot be confirmed afterwards; payouts T+2, daily or weekly.
- Delivery: an address outside every zone sees no delivery methods and cannot order; pickup is offered only in zones where it is enabled; one region belongs to exactly one zone.
- Support rules `P-001`…`P-007` on `pravila-podderzhki`, including P-001 (money questions are escalated), P-002 (missing data after a clean import is escalated), P-006 (no invented timelines) and P-007 (known incidents are relayed, not re-escalated).

## Grep list for manual checks

```
grep -rniE 'BOM|маркер|ufeff|молча|по названию|пропуск|сентябр|СкладУчёт|Дом и сад|ВелоДвор|Кофе-точка|Лаванда|недоступ|Томск|обжар|Кемеров|Новосибир|сбой|отклон|18:00|115[235]|dasha' wiki/*.md
```

Expected: no matches except this README and the substring «молча» inside «по умолчанию».
