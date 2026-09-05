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
pnpm eval lint-wiki      # T1.6 is still a stub; do not treat exit 2 as a clean wiki
```

Until T1.6 lands, inspect the none control manually (including CRM and current messages), exempting uses after wiki_update. A passing `uses:` can mean a source leak, inference or a judge false positive; audit it before changing content. A confirmed wiki leak means the fact is present in the wiki. Fix the wiki,
not the scenario. Checks after a `wiki_update` step that promoted the item are exempt.

## Facts deliberately absent

### `csv-import-dropped-rows`

- **K1 personal, «Дом и сад».** Выгружает каталог из «СкладУчёт»: UTF-8 с BOM, разделитель «;», артикулы с ведущими нулями, sku в кавычках, импорт по понедельникам. The name «СкладУчёт» appears nowhere in the wiki.
- **K2 undocumented, product.** В версии до релиза 10 сентября режим «Только новые» сохраняет существующий товар при распознанном заголовке sku. Если BOM ломает заголовок, режим игнорируется: совпало название — товар и цена обновляются; не совпало — новый товар не создаётся, строка молча исчезает из отчёта. The wiki documents standard-mode sku matching and errors, not this conditional rule or its exception. Three branch decisions test meaning preservation; a pass on the normal branch alone may be inferred from the mode name.
- **K3 temporal, «Дом и сад», until 2026-09-10.** До релиза импортёра 10 сентября сохранять экспорт как «UTF-8 без BOM». No release dates or upcoming fixes anywhere in the wiki.
- **K4 personal, «Дом и сад».** 37 пропущенных позиций инженеры загрузили вручную 27 августа и попросили Марину их проверить. The isolation discriminator: unlike K3, none of it can be reached from generic BOM advice, so `must_not_use` on another merchant's thread measures leakage only.
- **K5 undocumented, product.** Релиз импортёра от 10 сентября вышел: BOM удаляется автоматически, пропущенные строки видны в отчёте, сохранять «без BOM» вручную больше не нужно. Learned only from the 11 September coach note — the wiki has no release notes, and the August note stated a plan, not an outcome.

### `csv-rule-source` (opt-in, `evals/controls/`)

This is the direct-source counterpart to the three CSV branch questions. It copies the
original engineer explanation into each current thread and runs with `none`, with no
consolidation or wiki update. Its successful rubric checks are expected; this is an explicit
source-context control, not a test that none should forget the supplied explanation.
The conditional rule remains absent from the wiki itself.

### `setup-from-the-question`

- **K1 personal, «Кофе-точка».** Использует двухстадийную оплату: списание подтверждают вручную, когда кофе обжарен и уходит в доставку; обжаривают под заказ раз в неделю, по пятницам. The wiki documents two-stage mode and the 7-day hold generally, never which merchant uses it or why.
- **K2 personal, «Кофе-точка».** Доставляет только по Томской области: одна зона плюс самовывоз из обжарочного цеха в Томске; других регионов в зонах нет. The wiki explains how to restrict delivery to a region, never which merchant did. No place names anywhere in the wiki.

### `payment-provider-incident`

- **K1 temporal, shared, 2026-09-05 12:00–18:00.** «Оплатим» не проводит платежи по картам ни у одного магазина, покупатели видят «платёж отклонён»; восстановление к 18:00; оплата по QR работает. No incident, outage, date or recovery time is mentioned in the wiki; P-007 only says how known incidents are communicated.
- **K2 personal, «Кофе-точка».** По заказу 1153 списание без оплаченного заказа; отдельный случай ведёт eng.dasha и обещала ответить Антону. The scored fact is narrowed to the open case; the other order numbers remain source context. No order numbers or engineer names anywhere in the wiki.
- **K3 undocumented, shared (not a documentation candidate).** «Оплатим» подтвердил 7 сентября в 10:20 восстановление приёма карт; неоплаченные заказы можно оплатить снова. This is a historical recovery confirmation, not an inference from the expired estimate.

### `customer-setup-change`

- **K1 personal, «Лаванда».** Использовала двухстадийную оплату с ручным подтверждением перед отправкой.
- **K2 personal, «Лаванда».** С 8 сентября новые заказы оплачиваются одностадийно, списание сразу, без ручного подтверждения. The wiki describes both modes, never this merchant's selection or its change date.

### `human-reply-only`

- **K1 personal, «Лаванда».** 4 сентября eng.oleg восстановил 23 позиции каталога из резервной копии; повторно загружать исходный файл не нужно. This fact is stated only in the operator's public reply after handoff.

### `recall-under-noise` (opt-in, `evals/stress/`)

- **K1 personal, «Кофе-точка».** Единственная зона доставки — Томская область, плюс самовывоз из цеха в Томске. Reuses the delivery constraint from `setup-from-the-question`, then adds unrelated draft catalogue tickets. Sample SKUs and prices are distractors, not knowledge targets.

## Facts that must be present (baselines the scenarios rely on)

- CSV: UTF-8, delimiter `,` or `;` detected from the first line, required columns `sku`, `name`, `price`, `description` up to 5000 characters, 10 000 rows per import, existing products updated by `sku`, errors listed in the import report.
- Payments: cards and QR via «Оплатим»; one-stage and two-stage mode; a hold is cancelled automatically after 7 days and cannot be confirmed afterwards; payouts T+2, daily or weekly.
- Delivery: an address outside every zone sees no delivery methods and cannot order; pickup is offered only in zones where it is enabled; one region belongs to exactly one zone.
- Support rules `P-001`…`P-007` on `pravila-podderzhki`, including P-001 (money disputes and charges are escalated, how payment and the hold work is answered), P-002 (data missing *now* is escalated, a retrospective question about a fixed import is answered), P-006 (no invented timelines) and P-007 (known incidents are relayed, not re-escalated).

## Grep list for manual checks

```
grep -rniE 'BOM|маркер|ufeff|молча|по названию|пропуск|сентябр|СкладУчёт|Дом и сад|ВелоДвор|Кофе-точка|Лаванда|недоступ|Томск|обжар|Кемеров|Новосибир|сбой|отклон|18:00|115[235]|dasha' wiki/*.md
```

Expected: no matches except this README and the substring «молча» inside «по умолчанию».
