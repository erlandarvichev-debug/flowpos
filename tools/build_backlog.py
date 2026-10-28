"""Deterministic self-contained backlog and exact local OpenAPI contract."""
from pathlib import Path
import csv, json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'erp'
# id|epic|priority|role|size|dependencies|task|acceptance
DATA = '''001|Baseline|P0|Tech lead|S||Зафиксировать репозиторий и владельцев данных|HEAD проверен remote; карта вызовов и чужих изменений; изоляция checkout
002|POS|P0|Rust engineer|L|001|Одна атомарная Rust-команда durable sale intent|Один connection; fault injection и SQLITE_BUSY; одна полная операция; нет сети в SQL retry
003|POS|P0|Backend/Rust|L|002|Durable payment и fiscal state machines|UNKNOWN переживает restart; timeout не создаёт второй платёж/чек; проверен status lookup провайдеров
004|POS|P1|Frontend/Backend|L|001,002|Canonical BackofficeProvider с capabilities|Нет обязательных oneCGUID/accountHref в домене; старые провайдеры проходят общий contract suite
005|POS|P0|Backend|M|007,008,009,004|Серверный inbox POS и stable operation identity|UNIQUE tenant+org+operation; миграция устройства сохраняет sale; ACK после commit
006|POS|P0|QA/Pilot owner|L|003,005|Пилотная смена и сверка оборудования|Продажа/возврат/смешанная оплата/печать/обрыв; ноль необъяснённых расхождений
007|Platform|P0|Backend|M|001|Tenant и organization composite identity|Два клиента и две организации не видят/не связывают чужие объекты
008|Platform|P0|Security/Backend|L|007|OIDC sessions RBAC grants и MFA|Revoke и expiry работают; org scope из session; field-level payroll permissions
009|Platform|P0|Backend/DBA|L|007|Postgres unit of work outbox и RLS|Runtime role без BYPASSRLS; rollback; composite FK; outbox после commit
010|ESF|P0|Backend/Frontend|M|001|Локальный синтетический ESF срез|Durable inbound/outbound/status/errors/dedup; UNKNOWN не resend; UI и signing boundary; тесты
011|ESF|P0|Integration lead|M|001|Получить актуальный SDK WSDL XSD и доступ|Bytes checksum version; test/prod service endpoints; onboarding auth TTL limits enums документированы
012|ESF|P0|Integration engineer|L|009,011,013,021|Адаптер получения и атомарный cursor|Повтор страницы и crash не теряют документ; частичная страница не подтверждается; сверка диапазона
013|ESF|P0|Backend/Security|M|009,011|Реестр XML схем и immutable raw bytes|Encoding/checksum сохранены; XXE/DTD отключены; unknown schema в карантине без потери полей
014|ESF|P1|Backend/Methodologist|M|012,025|Сопоставление товара контрагента и оснований|Manual override audited; receipt не создаёт stock/VAT; correction chain сохранена
015|ESF|P0|Integration engineer|L|011,013,029|Serializer исходящего документа|Golden XML по XSD; версии формы; totals/rounding; no silent truncation
016|ESF|P0|Security/Signing engineer|L|008,011,013|Signing provider и authority validation|Exact bytes hash; сертификат/назначение/полномочия/expiry; stale approval блокируется; нет key в логах
017|ESF|P0|Integration engineer|L|015,016,021|Отправка и reconciliation результата|Lost response/restart → UNKNOWN; status lookup доказан; нет слепого resend
018|ESF|P0|Methodologist/Backend|M|012,016|Решения по исправлению дополнению отзыву|Technical ACK отдельно от business acceptance; сроки/роль/основание; explicit approval
019|ESF|P0|Tax methodologist/Backend|L|012,039|Частичный зачёт НДС и корректировки|Quarter/year/amount/remainder/rule version; нельзя автоматически зачесть весь VAT при download
020|ESF|P1|Frontend|L|008,012,017,018|Рабочее место ESF для реальных пользователей|Tabs/filters/card/raw/history; UNKNOWN только сверка; partial bulk result; доступность клавиатурой
021|Platform|P0|Backend|M|009|Jobs lease fencing retry и DLQ|Stale worker не подтверждает чужой lease; jitter/Retry-After; unsafe stage не retry
022|ESF|P1|SRE/Integration|M|012,017,024|Метрики и runbook ESF|Alerts по lag/UNKNOWN/quarantine; trace и ответственный; secret redaction
023|ESF|P0|QA/Methodologist|L|017,018,019,020,022|Уполномоченный ESF sandbox pilot|Документы приняты реальным тестовым контуром; duplicate/correction/timeout доказательства; sign-off
024|ESF|P1|Backend/Support|M|012,017|Ошибки карантин и контролируемый replay|Error taxonomy; причина исправления; audit replay; same key different hash не заметается
025|Catalog|P1|Backend|M|009|Товары варианты единицы штрихкоды|Stable item ID; дубли и weight barcode; versions и external mappings
026|Catalog|P1|Backend/Frontend|M|025,008|Контрагенты договоры и реквизиты|Effective dates; адреса/БИН; доступ; нет чужих ссылок
027|Catalog|P1|Backend|M|025|Прайс-листы скидки и округление|Priority/interval; preview discount; immutable offline snapshot
028|Documents|P0|Backend|L|009,026|Общие документы версии и ссылки|Expected_version; immutable posted version; source/correction graph; duplicate post conflict
029|Documents|P0|Backend/Frontend|M|028,008|Согласования и simulate command|Hash/scope/sum/TTL bound; изменение отменяет approval; UI показывает эффект
030|Inventory|P1|Backend|L|025,028|Поступление и складские движения|Частичная приёмка/расхождения; qty и value; источник каждого movement
031|Inventory|P1|Accounting engineer|L|030|Себестоимость и дополнительные расходы|Fixture COGS2200 profit800 stock8800; остаток округления детерминирован; метод периода
032|Inventory|P1|Backend/Frontend|M|030|Резервы перемещения и адреса|Available=fact-reserved; нет двойного резерва при конкуренции; two-stage transfer
033|Inventory|P1|Backend/Frontend|M|030,031|Инвентаризация списание партии серии|Сверка с фактами; причины; lot/expiry; approved discrepancy
034|Sales|P1|Backend/Frontend|L|027,028,032|Заказ клиента отгрузка возврат|Partial fulfilment; return by basis; prices/tax snapshot; правильный склад/стоимость
035|Purchases|P1|Backend/Frontend|L|026,030,029|Потребность заказ поставщику и приёмка|Budget approval; qty expected/received; расхождения и возврат поставщику
036|Treasury|P1|Backend|L|028,026|Банк касса авансы и разнесение|Bank key scoped by account; дубли не зачисляют дважды; allocation/reversal audited
037|Treasury|P1|Backend/Frontend|M|036,029|Платёжный календарь и заявки|Согласование получателя/суммы; cash forecast scenarios; import не делает payout
038|Accounting|P0|Accounting engineer|L|028,031,036|Двойная запись и аналитики|Balanced entry; unique source/version; decimal rules; posting simulation accepted
039|Accounting|P0|Tax methodologist|L|038|Rule packs и налоговые регистры|Effective period/source/approval; воспроизводимость; golden tests не меняются под код
040|Accounting|P1|Accounting engineer|L|038,039|Закрытие периода и сторно|Locked period enforced server; reopen audited; balance/stock reconciliation
041|Accounting|P2|Accounting engineer|L|038,040|ОС НМА амортизация и РБП|Asset lifecycle; disposal; period rules; accepted reference dataset
042|Accounting|P1|Backend|M|036,038|Валюты курсы и переоценка|Источник/дата курса; точные decimal; realized/unrealized difference; audit
043|Reports|P1|Analytics/Frontend|L|038,040|P&L ДДС баланс и drilldown|Показатели раскрываются до документа; cutoff/currency/rule version; totals reconcile
044|Reports|P2|Analytics|M|043,037|Бюджеты проекты и план-факт|CFO dimensions; plan snapshot; gap reason; access scoped export
045|Import|P1|Backend/Frontend|L|025,026,028|Staging CSV Excel mapping и preview|Row errors; dry run totals; idempotent batch; no external effects on import
046|Import|P1|Integration engineer|L|045,005|Миграция 1С и МоегоСклада|Opening balances/delta/references; no duplicate sale after device migration; cutover ownership
047|Import|P1|Methodologist/Backend|L|030,031,039|Международный импорт и landed costs|Customs declaration/origin/currency/ТНВЭД; factual events separate; cost allocation accepted
048|Payroll|P1|Backend/HR methodologist|M|008,026,039|Сотрудник договор и кадровые даты|Role/field permissions; historical terms; no retroactive overwrite of payroll inputs
049|Payroll|P1|Backend/Frontend|M|048|Графики табель отпуска больничные|Effective dates; approved timesheet; absence overlap rules; source trace
050|Payroll|P1|Payroll engineer|L|048,049,039|Расчёт начислений удержаний и обязательств|Rule snapshot; exact rounding; period golden payslips accepted by methodologist
051|Payroll|P1|Backend/Frontend|L|050,037|Утверждение перерасчёт payslip и реестр выплаты|Closed run immutable; adjustment trace; approval separate from real payout
052|Tax/ISNA|P1|Tax methodologist|M|039,040|Профиль обязанностей и календарь|Forms/periods per org; source/effective dates; overdue ownership
053|Tax/ISNA|P1|Integration lead|M|052|Получить ИСНА контракты по нужным ФНО|Per-form access/schema/receipt/signing confirmed; no invented universal endpoint
054|Tax/ISNA|P1|Backend/Frontend|L|053,039,016|Сборка ФНО контрольные соотношения и отправка|Drilldown fields; immutable submission; final accepted receipt; correction history
055|NKT|P1|Integration engineer|M|025,011|Подтвердить НКТ contract и environments|OpenAPI checksum auth/limits; test platform distinguished from productive NKT
056|NKT|P1|Backend/Frontend|L|055,025|Mapping NTIN KZTIN заявки и статусы|Own stable ID; source/history; failed matching not silent; status reconciliation
057|Statistics|P1|Methodologist/Integration|M|052|Установить формы респондента и доступ|Для каждой формы XML/API/export подтверждён; general automation not assumed
058|Statistics|P1|Backend/Frontend|L|057,016,043|Статформы validation package и receipt|Период/форма/version; controls; submit status accepted; correction evidence
059|EDO|P2|Backend/Security|L|013,016,029|Межфирменные envelopes и архив подписей|Recipient grant; two independent tenants; signature evidence/retention/export
060|CRM|P1|Backend/Frontend|L|026,034|Лиды сделки воронки и активности|Owner grants; stage history; deal→order→margin links; revenue not from stage alone
061|CRM|P2|Integration/Frontend|M|060,008|Коммуникации задачи и шаблоны|Consent/access; dedup inbound; channel-specific failures; no unsolicited send
062|Autopilot|P1|Backend/Security|L|008,029,043|Policy engine A0-A3 и лимиты|Atomic reservations; stop/revoke; split commands cannot evade limits; UNKNOWN retains reserve
063|Autopilot|P1|AI engineer|L|062,043|Помощник с доказательствами и draft actions|Org/time/source citations; prompt injection data isolation; no self approval
064|MCP|P2|Backend/Security|L|062,063|MCP read/draft/propose и OAuth|Scopes/audience/revoke; no arbitrary SQL URL shell; client conformance pinned
065|Forecast|P2|Analytics|L|043,037,060|Прогноз ДДС продаж и закупки|Baseline/backtest/no future leakage; uncertainty; stockout/leadtime/cash constraints
066|Frontend|P1|Design/Frontend|M|008|Design system browser ERP и role nav|No Tauri in browser core; org/period visible; keyboard/focus/mobile table
067|Frontend|P1|Frontend|M|066,028|Документ list/card/history и bulk results|Cursor/filter; field errors; conflict diff; partial success; permission-safe export
068|Security|P0|Security engineer|L|008,009|Threat model и boundary tests|Tenant escape/IDOR/CSRF/SSRF/XXE; abuse cases and fixes; actual runtime role tests
069|Security|P0|Security/SRE|M|068|Vault crypto key rotation и retention|No secret in log/Git/LLM; encrypted backups; revoke drill; retention/legal hold
070|Security|P0|Legal/Security|M|069|ПД география и передача LLM|Утверждены размещение/backup/index/transfer legal basis и data minimization
071|SRE|P1|SRE|M|009,021|Metrics traces logs и SLO|Lag/UNKNOWN/queue/ledger alerts; redaction; owner and escalation runbooks
072|SRE|P0|DBA/SRE|L|069,071|Backup PITR restore drill|DB+objects+signatures восстановлены; measured RPO/RTO; checksum/link reconciliation
073|QA|P0|QA engineer|L|009,028,038|Golden financial and property suite|Fixture receipt/sale/cost; debit=credit; concurrent post; closed period; random replay
074|QA|P0|QA/Security|L|068,020,067|Browser E2E access and workflow|Org switch/tabs/stale approval/UNKNOWN/bulk; keyboard and screen reader check
075|QA|P1|QA/DBA|L|072,046|Migration rehearsal и crash matrix|Expand/contract old/new clients; rollback/forward plan; disk full/BUSY/unknown commit
076|QA|P1|Performance engineer|M|071,073|Load test пилотных объёмов|Измерены p95/error/queue; цели согласованы; test data synthetic; no production load
077|Release|P0|Tech lead/Security|M|068|Разобрать dependency advisories baseline|Четыре исходных advisories классифицированы; targeted upgrade+regression; no blind audit fix
078|Release|P1|Release engineer|M|072,075,077|CI supply chain и signing release artifacts|Type/schema/tests/secret scan/SBOM; separate env secrets; approved immutable artifact
079|Release|P0|Product/Methodologist|L|006,023,040,051,054,056,058,074|Матрица готовности полного ERP|Каждый модуль/роль/сценарий имеет evidence/sign-off; ESF срез не объявлен всем ERP
080|Release|P0|Product/SRE|M|078,079,070|Production go/no-go и pilot rollout|Отдельное разрешение; tenant/org flags; rollback/kill switch; reconciliation owner
081|ESF access/concurrency|P0|Backend/QA|M|010|Fixture principal grants и lease fencing локального ESF|Scope из provider; org/action guard; шесть процессов; crash/restart; late callback fenced; UI карантина и read-only
082|ESF PostgreSQL|P0|Backend/DBA|M|081|ESF SQL migration restricted role RLS и concurrent claim|Применение дважды; NOLOGIN/NOBYPASSRLS owner/runtime; реальные concurrent sessions и restart fixture cluster; HTTP PG adapter ещё не подключён
'''

def build():
    rows=[]
    for line in DATA.strip().splitlines():
        i,epic,p,role,size,deps,title,accept=line.split('|')
        rows.append(dict(id='FP-'+i,epic=epic,priority=p,owner_role=role,size=size,
                         dependencies=','.join('FP-'+d for d in deps.split(',') if d),
                         status='DONE_LOCAL' if i in ('001','010','081') else 'DONE_SQL_FIXTURE' if i=='082' else 'PLANNED',title=title,acceptance=accept))
    ids={r['id'] for r in rows}
    assert all(set(r['dependencies'].split(','))- {''} <= ids for r in rows)
    with (OUT/'BACKLOG.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=rows[0].keys());writer.writeheader();writer.writerows(rows)
    text=['# Полный backlog FLOWPOS ERP','', '82 задачи. DONE_LOCAL и DONE_SQL_FIXTURE подтверждают только локальный срез/SQL-проверки. Роли обозначают компетенцию, конкретные исполнители не назначены. S/M/L — относительный размер, не срок. Dependencies обязательны для production реализации; mock может развиваться независимо.','']
    for r in rows:
        text += [f"## {r['id']} · {r['title']}",f"{r['epic']} | {r['priority']} | {r['owner_role']} | {r['size']} | {r['status']}",f"Зависимости: {r['dependencies'] or 'нет'}. Приёмка: {r['acceptance']}.",'']
    (OUT/'BACKLOG.md').write_text('\n'.join(text),encoding='utf-8')
    return rows

def openapi():
    error={'type':'object','required':['code'],'properties':{'code':{'type':'string'}}}
    invoice={'type':'object','additionalProperties':False,'required':['number','amountMinor','currency'],'properties':{'number':{'type':'string','minLength':1,'maxLength':100},'amountMinor':{'type':'string','pattern':'^[1-9][0-9]{0,14}$'},'currency':{'type':'string','enum':['KZT']}}}
    doc={'type':'object','required':['id','tenantId','orgId','operationId','direction','payload','payloadHash','state','revision'],'properties':{k:{'type':'string'} for k in ['id','tenantId','orgId','operationId','payload','payloadHash','revision']}}
    doc['properties'].update({'direction':{'type':'string','enum':['IN','OUT']},'state':{'type':'string','enum':['DRAFT','APPROVED','SENDING','UNKNOWN','REGISTERED','REJECTED','RECEIVED','QUARANTINED']},'externalId':{'type':['string','null']},'errorCode':{'type':['string','null']},'correctionOf':{'type':['string','null']}})
    doc['properties'].update({'version':{'type':'integer','minimum':1},'schemaVersion':{'type':'string'},'approvalExpiresAt':{'type':['integer','null']}});doc['required']+=['version','schemaVersion']
    def response(schema,description='Success'):return {'description':description,'content':{'application/json':{'schema':schema}}}
    def op(summary,schema=None,output=None,status='200'):
        o={'summary':summary,'responses':{status:response(output or {'$ref':'#/components/schemas/Document'}),'400':response(error,'Invalid JSON'),'403':response(error,'Host/origin/token denied'),'404':response(error,'Not found'),'409':response(error,'Domain conflict'),'413':response(error,'Body too large'),'500':response(error,'Internal error')}}
        if schema is not None:o.update({'security':[{'localToken':[]}],'requestBody':{'required':True,'content':{'application/json':{'schema':schema}}}})
        return o
    empty={'type':'object'}
    paths={'/api/session':{'get':op('Получить локальный token; только same-origin',output={'type':'object','properties':{'token':{'type':'string'},'mode':{'const':'SYNTHETIC'},'gate':{'const':'CONTRACT_UNVERIFIED'}}})},
           '/api/documents':{'get':op('Журнал fixed stand tenant/org; максимум 200',output={'type':'array','items':{'$ref':'#/components/schemas/Document'}})},
           '/api/fixtures/inbound':{'post':op('Получить один синтетический fixture с дедуп',empty,{'type':'array','items':{'$ref':'#/components/schemas/Document'}})},
           '/api/outbound':{'post':op('Создать синтетический исходящий',{'type':'object','required':['operationId','invoice'],'properties':{'operationId':{'type':'string','pattern':'^[A-Za-z0-9._-]{1,100}$'},'invoice':{'$ref':'#/components/schemas/Invoice'}}},status='201')}}
    for action in ['approve','send','reconcile']:
        schema={'type':'object','required':['payloadHash','expiresAt'],'properties':{'payloadHash':{'type':'string'},'expiresAt':{'type':'integer','description':'Unix milliseconds; <= now + 5 minutes'}}} if action=='approve' else empty
        paths['/api/documents/{id}/'+action]={'parameters':[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],'post':op({'approve':'Тестовое согласование; не ЭЦП','send':'Только synthetic gateway; UNKNOWN не resend','reconcile':'Только synthetic status lookup'}[action],schema)}
    spec={'openapi':'3.1.0','info':{'title':'FlowPOS ESF LOCAL SYNTHETIC stand','version':'0.1.0','description':'Internal implemented stand API. Not official IS ESF API. No production auth or network transport. Host/Origin must match exact loopback. All data synthetic.'},'servers':[{'url':'http://127.0.0.1:14840'}],'paths':paths,'components':{'securitySchemes':{'localToken':{'type':'apiKey','in':'header','name':'X-Flowpos-Local'}},'schemas':{'Invoice':invoice,'Document':doc,'Error':error}}}
    spec['info']['version']='0.2.0'
    spec['info']['description']='Internal synthetic ESF API. AuthProvider supplies fixed local fixture principal; header selects organization only within server grants and never supplies identity/tenant. No credentials, live ESF or production authentication.'
    session=paths['/api/session']['get']['responses']['200']['content']['application/json']['schema']['properties']
    session.update({'identitySource':{'const':'LOCAL_FIXTURE'},'subject':{'type':'string'},'organizations':{'type':'array','items':{'type':'object','properties':{'id':{'type':'string'},'actions':{'type':'array','items':{'enum':['read','draft','approve','send','reconcile','ingest']}}}}}})
    paths['/api/fixtures/inbound']['post']['requestBody']['content']['application/json']['schema']={'type':'object','additionalProperties':False,'properties':{'fixture':{'enum':['standard','unsupported']}}}
    paths['/api/documents/{id}']={'parameters':[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],'get':op('Scoped document and preserved raw fixture')}
    paths['/api/documents/{id}/reset-approval']={'parameters':[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],'post':op('Return expired approval to draft; no signing or resend',{'type':'object'})}
    for path,item in paths.items():
        for method,operation in item.items():
            if method not in ('get','post'):continue
            operation['responses']['401']=response(error,'Fixture principal missing/expired/disabled')
            if path!='/api/session':operation.setdefault('parameters',[]).append({'name':'X-Flowpos-Organization','in':'header','required':True,'description':'Organization selector; authorized against principal grants. Tenant never comes from client.','schema':{'type':'string'}})
            if method=='post':
                schema=operation['requestBody']['content']['application/json']['schema'];schema['additionalProperties']=False
                if path.startswith('/api/documents/'):
                    schema.setdefault('properties',{})['expectedVersion']={'type':'integer','minimum':1};schema.setdefault('required',[]).append('expectedVersion')
    (OUT/'contracts'/'esf-stand.openapi.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    rows=build();openapi();print(f'Built {len(rows)} tasks and implemented stand OpenAPI')
