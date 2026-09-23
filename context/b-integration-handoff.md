# Передача B → A: фактические границы интеграции

Срез кода 23.09.2026. Это карта подключений, а не акт сквозной приёмки. Владение файлами и зависимости 09/09a/10/11/13/14/14a/15 описаны в `feature-specs/parallel-work-plan.md`.

## Готовые серверные входы B

| Вход | Назначение и граница вызова A |
| --- | --- |
| `lib/ai/explain-recommendations.ts`: `explainRecommendations(input: ExplanationInput, signal?: AbortSignal)` | OpenAI: только ссылки на сохранённые факты рекомендации, возвращает batch `succeeded/degraded`. Типы входа, `evidenceVersion`, provenance и usage — `lib/ai/explanation-context.ts`. Нельзя вызывать live без отдельного разрешения пользователя; ключ не читать для проверки этого handoff. |
| `lib/ai/supplier-attention.ts`: `supplierAttention(input: AttentionInput, signal?: AbortSignal)` | NVIDIA: внимание по группам поставщиков, без права менять количество/утверждать. Те же ограничения фактов и резервного текста. |
| `lib/ai/*-core.ts`: `explainRecommendationsCore(input, config, options?)`, `supplierAttentionCore(input, config, options?)` | Инъекция transport для изолированных тестов; production-вызов идёт через два серверных входа выше. |
| `lib/realtime/publish-run-status.ts`: `publishCommittedRunStatus(snapshot: RunSnapshot, client: LiveblocksRoomPort | null, options?)` | Вызывать **после коммита** `stateVersion`; ошибка публикации не меняет БД. DTO `RunSnapshot`/event — `lib/realtime/contracts.ts`. |
| `lib/realtime/ownership.ts`: `createRunOwnershipLookup(pool)` | DB lookup связывает run, project и активного владельца. `lib/realtime/auth-route.ts`: `createLiveblocksAuthHandler(dependencies)` получает Clerk user и same-origin guard; `app/api/liveblocks-auth/route.ts` подключает route. Разрешение комнаты только на чтение точного run. |

## Что A ещё должен предоставить

- `app/api/projects/**` сейчас содержит проекты, datasets и upload/finalize/attempts. В `app/api` нет маршрутов `runs`, `review`, `approval`, `export`: реализации 09, 09a worker-dispatch и 14 нельзя считать завершёнными по наличию DTO или таблиц БД. `finalize` оставляет импорт `awaiting-validation`; фоновой проверки и публикации версии из HTTP-пути нет.
- Для 09 связать сохранённый результат 07/08 с `CalculationRun`, пагинацией рекомендаций и фактами для AI. Подключать AI только после сохранения детерминированного результата, при отказе оставлять числовой результат. Публиковать Liveblocks после коммита; серверный снимок БД остаётся источником истины.
- Для 13/14a B нужен работающий API: GET проекта/версии/запуска, POST run с идемпотентным ключом, PATCH review, approve и CSV download. `lib/client/procurement-api.ts` даёт общий JSON transport, но не заменяет эти маршруты и не проводит бинарный S3/CSV поток.

## Сверка DTO перед подключением

- `lib/contracts/runs.ts` требует `configuration.parametersHash`, `configurationHash`, `requestHash`, `stateVersion`, `reviewVersion`, `coverageGate` и `explanationStatus`; эти поля не эквивалентны друг другу. Снимок Liveblocks несёт только `stateVersion` и указатель на запуск, а не полный `CalculationRun`.
- `lib/contracts/recommendations.ts` использует `reviewVersion`, `linesHash`, `requestHash` и `approvalId` в разных стадиях review/approval/export. В плане передачи `parallel-work-plan.md` фигурирует `snapshotHash`; фактический DTO называет хеш утверждённых строк `linesHash`. Согласовать wire-контракт до подключения кнопок; не вычислять хеш по видимой странице с пагинацией.
- `lib/ai/explanation-context.ts` требует `evidenceVersion` на строке/группе. Это не `datasetVersionId`, `stateVersion` или `reviewVersion`; A должен назначить воспроизводимую версию сохранённого evidence. Преобразование доменного результата в этот DTO пока отсутствует.

## Приёмка и статус

`/workspace` без параметров — локальное синтетическое демо. `/projects` читает/создаёт реальные проекты; `/workspace?projectId=UUID` читает проект и страницы версий данных. Смена сессии/проекта скрывает прежние данные и отменяет запросы;401/403/404 очищают частные данные. Загрузка/расчёт/проверка/экспорт для реальных проектов ещё не подключены. Авторизованный браузерный путь требует Clerk/DB и остаётся pending.

| Спецификация B | Проверенное состояние | Что осталось |
| --- | --- | --- |
| 03 | Clerk provider/pages, server identity, Origin, отсутствие обхода при пустых ключах | Живой вход/выход с Clerk |
| 12 | Светлая02A, четыре раздела, компактный проект, мобильные иконки; локальные правки/подтверждение | Это демо на синтетике, а не результат сервера |
| 10 + NVIDIA | Проверенные серверные адаптеры, ссылки на факты, fallback, ограниченные таймауты | Task `trigger/explain-recommendations.ts`, AI-artifact repository A, доменный mapper, живые вызовы |
| 11 | Авторизация точной комнаты с PostgreSQL-владением, publisher, provider/controller | Вызов publisher из09 и живой Liveblocks |
| 13 | Реальные проекты и чтение версий данных API06; общий безопасный transport | Upload/mapping09a, run09, реальные рекомендации и история |
| 14a | Демо правки/явное подтверждение и транспорт | Реальные PATCHreview/approve/download послеAPI14; согласованный hash |
| 15 | README, передача, локальные тесты/сборка, браузер демо и закрытого доступа | Полный импорт→расчёт→утверждение→CSV, M1–M5E2E и liveпровайдеры |

После объединения с `main` `3ea1770` прошли215/215 тестов Node24:44 B,60 серверных,110 domain07/08,1 realtime ownership на временной PostgreSQL. Lint, TypeScript и Webpack build прошли. Browser production3100: безClerk закрыты проекты/реальныйworkspace,API503; invalidUUID не открывает проект; в демо390px4иконки работают, видимых подписей нет, overflow/JSerrors0. Ремонт testloader и синтетической fixture устранил две ошибки пришедшего объединения07/08 без изменения формул. Тесты БД выполнялись последовательно, Docker/облачные аккаунты не использовались.

В15 обязательны полный путь и отдельное доказательство live-сервисов. Зелёные локальные проверки не закрывают эти пункты. Для совместного запуска сначала объединить веткуB `01-agent`, затем передать09/09a/14, согласоватьDTO выше, настроитьClerk/PostgreSQL/S3/Trigger/Liveblocks, применить SQL-миграции и провести сквозной сценарий. OpenAI подключать только после снятия отдельного пользовательского запрета.
