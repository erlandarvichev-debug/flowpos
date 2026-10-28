# Источники и границы доказательств

Редакция 2.1: desktop-проверка официальной ссылки из S04 повторена один раз новым desktop-путём. Ответ SDK esf-sdk-311225.rar: HTTP200, redirect portal.kgd.gov.kz/kk/, content-type text/html, 129604 bytes, magic <!DOCTYPE html>. Источник контракта не получен, файлы не запускались; evidence/stage2-sdk-desktop.json. PostgreSQL fixture использует 16.9; документация RLS закрепляется на https://www.postgresql.org/docs/16/ddl-rowsecurity.html . SQL-тесты — доказательство поведения именно fixture, не наличия production доступа.

Дата актуальной проверки: 27 октября 2026. Наличие публикации не означает получение доступа к организации или подтверждение промышленного контракта. Проектные решения отделены от официальной wire specification.

| ID | Источник | Что подтверждает / что ещё проверить |
| --- | --- | --- |
| R01 | https://github.com/erlandarvichev-debug/moysklad-flowpos/tree/e87ab0bd3cab1a130fdc114078d772200d3223b1 | Фактический baseline; GitHub branch API и git ls-remote подтвердили SHA заново |
| S01 | https://www.kgd.gov.kz/ru/content/api-interfeys-elektronnye-scheta-faktury-1 | Публикация API/SDK; ссылка esf-sdk-2025.zip не доказывает актуальность production |
| S02 | https://nursultan.kgd.gov.kz/ru/news/ob-izmeneniyah-form-snt-i-esf-v-esf-1-165188 | Публикация 15.05 / обновление 01.06.2026, SDK-кандидат 270426.rar и test3; повторное чтение с desktop timed out |
| S03 | https://vko.kgd.gov.kz/ru/news/uvazhaemye-razrabotchiki-uchetnyh-sistem-i-nalogoplatelshchiki-8-165247 | Другой SDK-кандидат esf-sdk-311225.rar; версия должна быть подтверждена оператором |
| S04 | https://www.gov.kz/org/kgd/press/news/details/1191955?lang=ru | Прочитано: период/год, частичный зачёт НДС и последующие корректировки; получение ЭСФ не равно полному зачёту |
| S05 | https://www.gov.kz/org/kgd/press/news/details/1135842 | Прочитано: подтверждение/отклонение исправленных/дополнительных/отзыва; legal decision отдельно от delivery ACK |
| S06 | https://pki.gov.kz/developers/ | Официальная точка для средств НУЦ; актуальный SDK/алгоритмы/политики проверки требуют отдельного получения |
| S07 | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | Перед реализацией закрепить major version и проверить FORCE RLS/runtime role; DDL в пакете — проектный пример |

## Результат исследования контракта ЭСФ

Опубликованные кандидаты: esf-sdk-2025.zip, esf-sdk-311225.rar и 270426.rar. Проверки родительской исследовательской задачи: первые ссылки вернули HTML/redirect, 270426.rar — HTTP 503, www вариант — HTML. Точные байты архива, checksum, WSDL и XSD не получены. Корни production/test SPA дают оболочку, не контракт. Бинарники архивов не запускались. Старые FAQ 2015 года не используются как замороженный контракт 2026.

Неизвестны: текущие send/status methods, enums, session TTL, ClientID onboarding, signing algorithms/profile, batch limits, server-side dedup, точные test/prod service endpoints. Интерфейс EsfGateway.send/lookup — внутренний контракт FlowPOS, его нельзя копировать в SOAP как подтверждённые методы портала.

## Lineage исходных Library материалов

1. `libfile_cce2e4fd08c88191a5539d80dd79dab5`, файл `file_00000000031c81f4a1657b68278d5c96`, 3730 bytes, FlowPOS_ERP_Start_Claude_Code(1).txt.
2. `libfile_214a1a5be58081919dca627ad1629d90`, файл `file_00000000ae8081f49602b53d22dc8141`, 239886 bytes, FlowPOS_ERP_Technical_Project_2026-10-27(2).docx, 33 страницы, 1689 строк извлечённого текста.

Оба прочитаны через Library. Поддержанная материализация официальным helper не завершилась: Windows Python не предоставляет os.setxattr. До этого sandbox попытка не скачала bytes; одна поддержанная попытка вне sandbox дошла до xattrs и завершилась ошибкой до установки финального файла. Исходные bytes локально не подтверждены, оригиналы не изменены, version guard не обходился. Новая редакция создаётся отдельным deliverable с этим lineage; это не replacement исходного Library ID.
