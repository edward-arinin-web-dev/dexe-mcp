# Безпека dexe-mcp — пояснення для клієнта

**Версія документа:** 2026-05-21  
**Покритий продукт:** `dexe-mcp` (npm-пакет `dexe-mcp`, поточна версія `0.5.8`)  
**Канонічна політика:** `SECURITY.md` у корені репозиторію — `https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/SECURITY.md`

---

## 1. Короткий висновок (для керівництва)

- **Локальний процес, без мережевого порту.** MCP-сервер запускається на машині оператора (інженера/користувача), спілкується з MCP-клієнтом (Claude Desktop / Claude Code) через stdio. Жоден TCP/HTTP-порт не відкривається. Це не SaaS і не централізований сервіс.
- **За замовчуванням ключі не торкаються MCP.** Кожен write-інструмент повертає `TxPayload = { to, data, value, chainId }`. Підписує гаманець оператора (MetaMask, Safe, Ledger тощо). MCP сам нічого не транслює, доки оператор явно не ввімкне підписувач.
- **Підписувач — opt-in.** Лише якщо оператор сам встановить env-змінну `DEXE_PRIVATE_KEY`, активуються три інструменти: `dexe_tx_send`, `dexe_tx_status`, та broadcast-гілки composite-флоу (`dexe_proposal_create`, `dexe_proposal_vote_and_execute`). За замовчуванням — calldata-only.
- **Жодних викликів додому.** Сервер не надсилає телеметрію, не звертається до власних бекендів. Усі вихідні запити — лише до RPC, IPFS-шлюзу, субграфу та DeXe-бекенду, які оператор сам указав у конфігурації.
- **Мінімальна площина залежностей.** 9 runtime-залежностей. Жодних `axios`/`request`/`node-fetch` — лише вбудований `fetch`. Ethers v6 і MCP SDK — основні.
- **Відкритий код, MIT.** Усе аудитоване рядково. Reproducible build з TypeScript-джерел.
- **Відповідальне розкриття.** Контакт `edward.arinin@gmail.com`, SLA на ack ≤ 72 год.

---

## 2. Архітектура та межа довіри

```
   ┌─────────────────────┐   stdio    ┌──────────────────────────┐
   │  MCP-клієнт         │ ◀────────▶ │  dexe-mcp (Node 20+)     │
   │  (Claude Desktop /  │            │  • zod input validation  │
   │   Claude Code)      │            │  • ethers v6 calldata    │
   └─────────────────────┘            │  • optional Wallet signer│
            ▲                         └────────────┬─────────────┘
            │ людина схвалює                       │
            │ кожен виклик                         │ HTTPS (вихідне)
            │                                      ▼
   ┌────────┴────────┐         ┌──────────────────────────────────┐
   │ Оператор        │         │ Зовнішні ендпоінти (оператор     │
   │ (інженер DeXe)  │         │ конфігурує):                     │
   └─────────────────┘         │  • EVM RPC (BSC/ETH)             │
                               │  • IPFS-шлюз (Pinata)            │
                               │  • Субграф (The Graph)           │
                               │  • DeXe Backend API (off-chain)  │
                               └──────────────────────────────────┘
```

**Межа довіри:** ми довіряємо процесу `dexe-mcp` те саме, що довіряє йому оператор у момент запуску — і нічого більше. MCP-клієнт виступає UX-обгорткою; усі дії явно ініціюються людиною з агентського чату, а кінцеву авторизацію транзакції дає або хардварний/браузерний гаманець, або (в opt-in-режимі) приватний ключ у env.

---

## 3. Загроза №1 — Безпека ключів і підписання

### 3.1 Поведінка за замовчуванням (рекомендована)

`DEXE_PRIVATE_KEY` **не встановлений**. У цьому стані:

- Інструменти `dexe_tx_send` / `dexe_tx_status` не зареєстровані в реєстрі MCP-сервера — їх просто немає у списку доступних викликів.
- Усі builder-інструменти (`dexe_proposal_build_*`, `dexe_vote_build_*`, `dexe_dao_build_deploy` тощо) повертають структурований `TxPayload`. Жодного `eth_sendTransaction` не відбувається з боку MCP.
- Оператор копіює `to/data/value` у MetaMask / Safe / Ledger UI, **бачить декодований намір** (можна додатково прокрутити через `dexe_decode_calldata` чи `dexe_decode_proposal`), і свідомо підписує.

Це той режим, який ми рекомендуємо клієнтам за замовчуванням.

### 3.2 Поведінка з увімкненим підписувачем (opt-in)

Якщо оператор свідомо встановлює `DEXE_PRIVATE_KEY=0x…`:

- Ключ читається **один раз** при старті процесу (`src/config.ts` → `process.env.DEXE_PRIVATE_KEY?.trim()`) і зберігається в пам'яті процесу.
- Усередині `SignerManager` (`src/lib/signer.ts`) ключ передається лише в конструктор `ethers.Wallet` — стандартна, аудитована бібліотека (`ethers@^6.13.0`).
- Ключ **ніколи** не пишеться в файл, не логуються в stderr, не передається в жоден HTTP-запит, окрім підписаних транзакцій до сконфігурованого RPC.
- Якщо ключ не встановлений, але викликається `dexe_tx_send`, помилка явно називає змінну (`DEXE_PRIVATE_KEY not set. Available DEXE_* env vars: [...]`) — без витоку значень.
- Cache: `SignerManager` тримає `Map<chainId, Wallet>` — один Wallet на ланцюг (бо provider різний). Ключ той самий.

### 3.3 Рекомендації клієнту

| Сценарій | Рекомендоване рішення |
|----------|----------------------|
| Виробничі операції (treasury, governance) | **Calldata-only режим.** Без `DEXE_PRIVATE_KEY`. Підписувач — Safe Multisig або Ledger. |
| Інтеграційні тести / автоматизація swarm | Окремий "operator hot wallet" з обмеженим бюджетом + alert на over-spend. Ніколи не використовуйте ключ з основними активами. |
| Розробка / локальна перевірка | BSC testnet (chain 97), безкоштовний faucet BNB. Жоден реальний капітал не задіяний. |

---

## 4. Загроза №2 — Prompt injection та зловмисні tool calls

### 4.1 Що може зловмисний LLM, якщо MCP-сервер уже запущено

LLM (Claude чи інший) формує JSON-аргументи tool call. Що ми робимо для захисту:

1. **Сувора валідація через `zod`.** Кожен інструмент описує схему параметрів (`z.string()`, `z.number().int().positive()`, `z.enum(...)`). Невалідний JSON відхиляється до виклику бізнес-логіки.
2. **Calldata-only за замовчуванням.** Навіть якщо LLM "видумує" виклик `dexe_proposal_build_token_transfer({ recipient: "0xATTACKER", amount: "10^18" })`, MCP лише **повертає** `TxPayload`. Жодне переведення не відбудеться без явного підпису оператора в його гаманці. Оператор бачить адресу-отримувача в UI MetaMask/Safe.
3. **Декодери для верифікації.** `dexe_decode_calldata` та `dexe_decode_proposal` працюють у read-only — оператор може попросити LLM розшифрувати власноруч згенерований payload і порівняти з людиночитаним описом.
4. **Лімітований whitelist для swarm-харнесу.** Окремо для testing-харнесу (`tests/swarm/`) — preflight, fund-pool і orchestrator відмовляють у роботі з будь-яким DAO/токеном/RPC/отримувачем, який не знаходиться в активному ланцюговому allowlist (`SWARM_DAOS_TESTNET`/`SWARM_DAOS_MAINNET`). Hard guard від dripping wallet.

### 4.2 Що НЕ захищає MCP

- **MCP не аналізує семантику запиту.** Якщо оператор інструктує LLM "переведи 1000 USDC на 0x…" і свідомо натискає Confirm у MetaMask — це поза межами захисту MCP.
- **MCP не модерує промпти.** Це робота MCP-клієнта (Claude). Recommendation: оператор використовує лише довірені MCP-сервери, не запускає невідомі.

### 4.3 У режимі підписувача (opt-in) — додаткове застереження

Якщо `DEXE_PRIVATE_KEY` встановлено, бар'єр з людиною знижується: `dexe_tx_send` транслює без додаткового підтвердження. У цьому режимі prompt-injection потенційно небезпечний. Контрзаходи:

- Використовуйте ключ із малим балансом.
- Конфігуруйте RPC з обмеженим діапазоном dest-адрес (на стороні RPC-провайдера) — або mempool guard на стороні гаманця.
- Не залишайте Claude-сесію без нагляду в режимі signer.
- Розгляньте `DEXE_PRIVATE_KEY` лише для CI/тестових сценаріїв, не для prod-операцій.

---

## 5. Загроза №3 — Supply chain (npm, залежності, build integrity)

### 5.1 Залежності

Runtime (`package.json` → `dependencies`):

| Пакет | Версія | Призначення |
|-------|--------|-------------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | MCP-протокол (Anthropic, MIT) |
| `ethers` | `^6.13.0` | EVM-кодування + опційний підписувач (audited, де-факто стандарт) |
| `execa` | `^9.5.0` | Виклик Hardhat (`dexe_compile`, `dexe_test`) як дочірнього процесу |
| `multiformats` | `^13.4.2` | CID-помічники для IPFS (Protocol Labs, MIT) |
| `p-limit` | `^6.2.0` | Concurrency control для паралельних викликів |
| `remark-parse`, `remark-gfm`, `remark-slate-transformer`, `unified` | — | Markdown → Slate для метаданих proposal |
| `zod` | `^3.23.8` | Валідація вхідних параметрів кожного tool |

Жодних мережевих клієнтів (`axios`, `node-fetch`, `request`) — використовується вбудований `fetch` (Node 20+).

### 5.2 Контроль ланцюга

- **npm provenance (з `v0.5.9`+).** Кожен реліз публікується через GitHub Actions (`.github/workflows/release.yml`) з прапором `npm publish --provenance`. Sigstore-підписана attestation прив'язує tarball до конкретного git-коміту і workflow-ран. На сторінці пакета на npmjs.com відображається бейдж "Provenance". Клієнт може верифікувати через `npm audit signatures` або `npm view dexe-mcp dist.signatures`.
- **OSSF Scorecard аудит** — щотижня + при кожному пуші у `main` через `.github/workflows/scorecard.yml`. Перевіряє branch protection, signed releases, pinned dependencies, token permissions, dependency-update tool, packaging, SAST, code review та ще ~10 категорій. Публічний score на `https://api.securityscorecards.dev/projects/github.com/edward-arinin-web-dev/dexe-mcp`. SARIF-результати у GitHub code-scanning.
- **Dependency Review на PR.** Кожен pull request, що змінює `package.json` / `package-lock.json`, автоматично діффиться проти GitHub Advisory Database. PR падає якщо додано залежність із `high`/`critical` CVE, або з GPL/AGPL ліцензією. Унеможливлює мерж уразливих deps.
- **CodeQL SAST.** GitHub-native статичний аналіз з query-pack `security-extended`. Сканує JS/TS-вихідник на prototype pollution, command injection, ReDoS, небезпечну десеріалізацію, path traversal, та інші CWE-патерни. Запуск: кожен PR/push у main + щотижня. Знахідки у вкладці Security репозиторію.
- **`overrides` у `package.json`** примусово піднімають уразливі transitive-залежності: `fast-uri >=3.1.2`, `hono >=4.12.18`, `ip-address >=10.1.1`, `express-rate-limit >=8.4.0`. Без них npm міг би взяти стару транзитивну версію.
- **`prepublishOnly` запускає `typecheck` + `build`** — пакет не публікується, якщо TypeScript не валідний. У релізному workflow додатково ганяється `npm test` + перевірка що тег відповідає `package.json` version.
- **MIT-ліцензія, відкритий код**, репозиторій `edward-arinin-web-dev/dexe-mcp`. Можна побудувати локально з джерел.
- **`files` whitelist у `package.json`** обмежує вміст npm-tarball до `dist/`, README, CHANGELOG, SECURITY, LICENSE, `.mcp.example.json`. Жодних випадкових файлів, скриптів post-install, env-файлів.
- **Жодного `postinstall`-хука** — нічого не виконується при `npm install` крім ванільного npm-розгортання.

### 5.3 Рекомендації клієнту

- Завжди пінити версію в MCP-конфізі: `^0.5` або точну.
- Запускати `npm audit` після pinning.
- Для high-assurance розгортань — клонувати репозиторій, перевіряти git-tag відповідає опублікованій npm-версії, будувати локально та посилатися на локальний `dist/index.js`.
- Опційно: запускати у відокремленому облікковому записі ОС / контейнері без доступу до сторонніх секретів.

---

## 6. Загроза №4 — Потоки даних (RPC / IPFS / Backend / Telemetry)

### 6.1 Що залишає процес

| Назовні куди | Коли | Що передається |
|--------------|------|----------------|
| **EVM RPC** (BSC/ETH, конфіг `DEXE_RPC_URL` / `DEXE_RPC_URL_TESTNET` / `DEXE_RPC_URL_MAINNET`) | `dexe_read_*`, `dexe_sim_*`, `dexe_proposal_state`, broadcast у режимі signer | `eth_call` / `eth_estimateGas` payloads; у режимі signer — підписана транзакція |
| **IPFS-шлюз** (`DEXE_IPFS_GATEWAY`, опційно `DEXE_IPFS_GATEWAYS_FALLBACK`) | `dexe_ipfs_fetch`, читання proposal-метаданих | GET-запити по CID |
| **Pinata API** (`https://api.pinata.cloud` — захардкоджено) | `dexe_ipfs_upload_*` | `multipart/form-data` з контентом, який оператор явно завантажує; `Authorization: Bearer <DEXE_PINATA_JWT>` |
| **Pinata dedicated gateway** | при читанні CID з `*.mypinata.cloud` | заголовок `x-pinata-gateway-token` із `DEXE_PINATA_GATEWAY_TOKEN` |
| **The Graph subgraph** (`DEXE_SUBGRAPH_POOLS_URL` тощо) | `dexe_read_dao_*`, `dexe_proposal_voters` | GraphQL-запити (read-only) |
| **DeXe Backend API** (`DEXE_BACKEND_API_URL`) | `dexe_auth_*`, off-chain proposal-флоу | JSON-запити для off-chain голосувань / автентифікації |
| **Hardhat CLI** (локально) | `dexe_compile`, `dexe_test` | spawn локального Hardhat у каталозі `DEXE_PROTOCOL_PATH` |

### 6.2 Що НЕ виходить назовні

- **Жодної телеметрії розробника.** Немає Sentry / Mixpanel / PostHog / custom analytics endpoint. Сервер ніколи не контактує з домейном автора.
- **Жодних `console.log` секретів.** Stderr-лог при старті виводить лише `DEXE_PROTOCOL_PATH` і чи увімкнено RPC (без URL), без жодного значення `DEXE_PRIVATE_KEY` чи `DEXE_PINATA_JWT`.
- **Жодних off-host файлових запитів.** Локальний доступ обмежений `DEXE_PROTOCOL_PATH` (Hardhat-каталог) та `.env` поряд із пакетом.

### 6.3 Контроль клієнта

- **Усі ендпоінти задає оператор.** Можна вказати приватний RPC, приватний IPFS-шлюз і dedicated subgraph — нічого не "вшито".
- **Якщо RPC не сконфігуровано** — інструменти, які його потребують, явно повідомляють про відсутність змінної. Жодного fallback на публічні (можливо ненадійні) ендпоінти.
- **IPFS не має дефолтних публічних шлюзів** (`NO_DEFAULT_GATEWAYS: []`). Це свідомий вибір: dweb.link / ipfs.io часто падають і повертають заміщені байти. Оператор має поставити свій.
- **Pinata-кредитки рекомендуємо тримати в окремому JWT, обмеженому одним проектом.** Pinata дозволяє ротувати JWT без впливу на gateway-токен.

---

## 7. Що оператор клієнта повинен зробити (checklist)

- [ ] Пінити версію `dexe-mcp` (`^0.5` або точну).
- [ ] Запускати MCP-сервер у звичайному режимі (без `DEXE_PRIVATE_KEY`) для будь-яких prod-дій з governance / treasury.
- [ ] Підписувати транзакції лише через Safe Multisig або Ledger.
- [ ] Для опційного signer-режиму — використовувати окремий hot-wallet з обмеженим балансом і моніторинг.
- [ ] У signer-режимі увімкнути broadcast-guards (захист `dexe_tx_send`):
  - [ ] `DEXE_SIGNER_ALLOWLIST` — список дозволених адрес `to` (B6); напр. лише GovPool + UserKeeper свого DAO.
  - [ ] `DEXE_SIGNER_MAX_VALUE_WEI` — стеля на `value` однієї транзакції в wei (B7).
  - [ ] `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` — ліміт broadcast-ів за хвилину (B10).
  - [ ] B9 (eth_call перед відправкою) працює автоматично в signer-режимі — окремого налаштування не потребує.
- [ ] Налаштовувати приватні endpoints (RPC, subgraph, IPFS gateway) — не використовувати публічні.
- [ ] Pinata JWT створювати окремо під проект, з мінімально потрібними правами.
- [ ] Усі секрети — в `.env` поряд з пакетом або в env-блоці MCP-клієнта; ніколи в git.
- [ ] Періодично запускати `npm audit` після оновлень.
- [ ] Тримати канал з нашою командою для розкриття вразливостей: `edward.arinin@gmail.com`.

---

## 8. Чого MCP **НЕ** гарантує (out of scope)

- Безпеку on-chain контрактів DeXe Protocol — окремий аудитний скоуп, репортувати в `https://github.com/dexe-network`.
- Захист від соціальної інженерії оператора (хтось говорить "встанови `DEXE_PRIVATE_KEY=…` — буде швидше"). Це людський фактор, не контролюється кодом MCP.
- Безпеку LLM-провайдера (Anthropic). Ми не контролюємо, що Claude робить з контекстом — це інший trust-domain.
- Безпеку RPC-провайдера (Infura, QuickNode, custom). MCP лише надсилає payload, не верифікує постачальника.
- Безпеку Pinata. Якщо Pinata скомпрометована — це проблема Pinata; MCP лише оператор їхнього API.

---

## 9. Розкриття вразливостей

| Канал | Деталь |
|-------|--------|
| Email | `edward.arinin@gmail.com` |
| SLA acknowledge | ≤ 72 години |
| Координація | До публікації advisory узгоджуємо timeline |
| Публічні issues | **Не** відкривати на GitHub для security-репортів |

Деталі для репорту: опис, мінімальний repro (tool-call + redacted env), версія (`dexe-mcp --version`), запропоноване виправлення.

---

## 10. Файли для глибокого аудиту

| Файл | Що там |
|------|--------|
| `src/index.ts` | Точка входу: stdio transport, завантаження `.env`, реєстрація tools |
| `src/config.ts` | Усе читання env — єдина точка |
| `src/lib/signer.ts` | Уся робота з приватним ключем (≈55 рядків) |
| `src/tools/txSend.ts` | Broadcast-логіка (≈150 рядків) |
| `src/rpc.ts` | Provider-кеш |
| `src/lib/ipfs.ts` | IPFS-fetch, gateway-token handling |
| `SECURITY.md` | Канонічна політика безпеки |
| `docs/ENVIRONMENT.md` | Повний довідник env-змінних |
| `package.json` → `dependencies` + `overrides` | Площина залежностей |

Усі — < 200 рядків кожен, легко рев'ювити вручну.
