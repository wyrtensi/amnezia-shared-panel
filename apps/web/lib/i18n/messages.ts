/**
 * Typed message dictionary for the web app.
 *
 * `ru` is the source of truth (the wording shipped today, verbatim). `en`
 * carries the English translations. The `satisfies Record<keyof typeof ru,
 * string>` guard below makes the two key sets identical at compile time: a key
 * present in one language but missing in the other, or an accidental extra key,
 * is a type error.
 *
 * Keys are flat, namespaced dot-strings. Values may contain `{var}`
 * placeholders that the provider's `t(key, vars)` interpolates.
 */

const ru = {
  // Language switch
  "lang.switch": "Сменить язык",

  // Theme toggle
  "theme.light": "Светлая тема",
  "theme.dark": "Тёмная тема",

  // Shared
  "common.cancel": "Отмена",
  "common.close": "Закрыть",
  "common.add": "Добавить",
  "common.adding": "Добавляем…",
  "common.save": "Сохранить",
  "common.name": "Название",
  "common.actions": "Действия",
  "common.noData": "Нет данных",
  "common.notFound": "Ничего не найдено",
  "common.loadFailed": "Не удалось загрузить данные",
  "common.downloadConf": "Скачать .conf",

  // Roles
  "role.user": "Пользователь",
  "role.admin": "Администратор",

  // Hint
  "hint.aria": "Подсказка",

  // Admin navigation / shell
  "nav.overview": "Обзор",
  "nav.users": "Пользователи",
  "nav.nodes": "VPN-ноды",
  "nav.policy": "Политики",
  "nav.rules": "Маршрутизация",
  "nav.audit": "Журнал",
  "nav.logout": "Выйти",
  "admin.myKeys": "Мои ключи",
  "admin.version": "Версия",
  "admin.title": "Управление VPN",

  // Direct login page (server-side Google, when not behind Cloudflare)
  "login.title": "Вход в панель",
  "login.subtitle": "",
  "login.google": "Войти",
  "login.notAllowed":
    "Этот аккаунт не в списке доступа. Попросите администратора добавить вас.",
  "login.unavailable": "Сервис временно недоступен. Попробуйте ещё раз.",
  "login.failed": "Не удалось войти. Попробуйте ещё раз.",
  "login.logout": "Выйти",

  // Panel self-update (admin overview)
  "update.title": "Обновление панели",
  "update.current": "Текущая версия",
  "update.built": "собрано",
  "update.commit": "коммит",
  "update.button": "Обновить панель",
  "update.confirmTitle": "Обновить панель?",
  "update.confirmBody":
    "Панель скачает свежий образ, применит миграции БД и перезапустится. Возможен короткий перерыв в доступе (~1 минута). База данных резервируется автоматически перед обновлением.",
  "update.confirm": "Обновить",
  "update.running": "Идёт обновление…",
  "update.runningHint":
    "Панель может ненадолго стать недоступной и затем вернётся. Эту страницу можно просто обновить через минуту.",
  "update.scheduled": "Обновление запущено",
  "update.requestedBy": "запросил",
  "update.lastOk": "Последнее обновление прошло успешно",
  "update.lastFail": "Последнее обновление не удалось",
  "update.disabled": "Механизм обновления не установлен на сервере",
  "update.disabledHint":
    "Установите хост-воркер один раз: sudo bash infra/prod/install-updater.sh",

  // Route profiles (shared)
  "route.full_tunnel": "Весь трафик",
  "route.ru_whitelist": "Только зарубежные (whitelist)",
  "route.ru_blacklist": "Только заблокированные (blacklist)",

  // Protocols (shared)
  "protocol.awg2": "AWG 2.0",
  "protocol.awg3": "AWG 3.1",

  // Key states (status badge)
  "status.provisioning": "Создаётся",
  "status.active": "Активен",
  "status.disabled": "Отключён",
  "status.revoking": "Отзывается",
  "status.revoked": "Отозван",
  "status.failed": "Ошибка",

  // Device types
  "device.base": "Устройство",
  "device.unspecified": "Не указано",
  "device.android": "Android",
  "device.ios": "iPhone iPad",
  "device.macos": "macOS MacBook",
  "device.windows": "Windows ПК",
  "device.linux": "Linux",
  "device.other": "Другое",
  // Base for the suggested key name. Separate from the card labels above
  // because "iPhone / iPad" is a fine label and a terrible key name.
  "device.name.android": "Android",
  "device.name.ios": "iPhone",
  "device.name.macos": "Mac",
  "device.name.windows": "ПК",
  "device.name.linux": "Linux",

  // Employee dashboard
  "emp.title": "Мои VPN-ключи",
  "emp.loadingProfile": "Загрузка профиля…",
  "emp.admin": "Администрирование",
  "emp.refresh": "Обновить",
  "emp.quotaUsage": "Лимит ключей",
  "emp.quotaPerNode": "До {limit} на каждом сервере",
  "emp.requestMore": "Запросить больше",
  "emp.devices": "Устройства",
  "emp.newKey": "Новый ключ",
  "emp.noKeys": "Ключей пока нет",
  "emp.noKeysHint":
    "Создайте отдельный ключ для компьютера или телефона — это займёт пару секунд.",
  "emp.createFirst": "Создать первый ключ",
  "routes.sectionTitle": "Добавление правил в профиль",
  "routes.title": "Свои маршруты",
  "routes.subtitle": "Дополнительные адреса поверх базовых списков",
  "routes.hint":
    "Добавьте свои домены и IP — они пойдут через VPN вместе с базовым списком выбранного профиля. Базовый список скрыт и подставляется автоматически. Изменения применяются при следующем экспорте конфигурации.",
  "routes.count": "Записей: {count}",
  "routes.ipLabel": "IP-адреса и подсети",
  "routes.ipPlaceholder": "например 1.2.3.4 или 10.0.0.0/8",
  "routes.domainLabel": "Домены",
  "routes.domainPlaceholder": "например example.com",
  "routes.save": "Сохранить маршруты",
  "routes.saving": "Сохранение…",
  "routes.saved": "Маршруты сохранены",
  "routes.saveFailed": "Не удалось сохранить маршруты",
  "routes.badIp": "Некорректный IP или подсеть",
  "routes.badDomain": "Некорректный домен",
  "routes.removeAria": "Удалить {value}",
  "routes.profileHint":
    "Выберите, к какому профилю добавить адреса. Профиль задаётся при создании ключа — ваши адреса применяются к ключам с этим профилем.",
  "routes.wl.desc":
    "Только зарубежные: иностранные ресурсы идут через VPN, российские — напрямую. Добавленные адреса тоже пойдут через VPN.",
  "routes.bl.desc":
    "Только заблокированные: через VPN идут лишь заблокированные сайты. Добавленные адреса тоже пойдут через VPN.",
  "emp.keyCreated": "Ключ создан",
  "emp.rotateConfirm":
    "Перевыпустить ключ с актуальными правилами? Старый конфиг перестанет работать — на устройстве нужно будет вставить новый ключ.",
  "emp.rotateToast":
    "Ключ обновляется. Когда статус станет «Активен», откройте «Показать ключ» и вставьте новый.",
  "emp.rotateFailed": "Не удалось обновить ключ",
  "emp.revokeConfirm": "Отозвать этот ключ? Устройство сразу потеряет доступ.",
  "emp.revoked": "Ключ отозван",
  "emp.revokeFailed": "Не удалось отозвать ключ",
  "quota.cellsAria": "{used} из {limit} ключей",
  "quota.cellIssued": "Ключ выпущен",
  "quota.cellFree": "Свободный слот",

  // Key card
  "keyCard.rulesUpdatedTitle": "Правила маршрутизации обновились",
  "keyCard.updateKey": "Обновить ключ",
  "keyCard.rulesUpdatedBody":
    "Перевыпустите ключ, чтобы применить новые правила. Старый конфиг перестанет работать — переустановите ключ на устройстве.",
  "keyCard.created": "Создан: ",
  "keyCard.traffic": "Трафик: ",
  "keyCard.reissue": "Перевыпустить",
  "keyCard.reissueTip":
    "Выдать новый ключ с текущими правилами. Старый перестанет работать — переустановите конфиг на устройстве.",
  "keyCard.provisioning": "Создаётся…",
  "keyCard.showQr": "Показать QR-код",
  "keyCard.qrAndLink": "QR-код и ссылка",
  "keyCard.revoke": "Отозвать ключ",
  "keyCard.copy": "Скопировать ключ",
  "keyCard.copying": "Копируем…",
  "keyCard.copied": "Скопировано",
  "keyCard.copyFail": "Не вышло",
  "keyCard.copyToast": "Ключ скопирован — вставьте его в AmneziaVPN",
  "keyCard.copyErrToast": "Не удалось скопировать ключ",

  // Create-key wizard
  "wizard.proto.awg3.label": "AmneziaWG 3.1",
  "wizard.proto.awg3.desc": "Защита заголовков и трейлеры (рекомендуется)",
  "wizard.proto.awg2.label": "AmneziaWG 2.0",
  "wizard.proto.awg2.desc": "Совместимость со старыми клиентами",
  "wizard.route.full_tunnel.desc": "Всё соединение идёт через VPN",
  "wizard.route.ru_whitelist.desc": "Иностранные ресурсы через VPN, RU напрямую",
  "wizard.route.ru_blacklist.desc": "Через VPN идут лишь заблокированные сайты",
  "wizard.recommended": "Рекомендуется",
  "wizard.awg3Hint": "Требуется AmneziaVPN {version}+",
  "wizard.rulesNotActive": "Правила ещё не активированы",
  "wizard.profileDisabled": "Выбор профиля отключён администратором",
  "wizard.createFailed": "Не удалось создать ключ",
  "wizard.title": "Новый VPN-ключ",
  "wizard.desc": "Один ключ предназначен для одного устройства.",
  "wizard.deviceType": "Тип устройства",
  "wizard.namePlaceholder": "Например, рабочий ноутбук",
  "wizard.nameDisplay": "Отображение ключа в клиенте",
  "wizard.nameDisplayHint":
    "Из чего собрать название подключения в приложении AmneziaVPN. Задаётся при создании ключа и позже не меняется.",
  "wizard.nameDisplay.server": "Название сервера",
  "wizard.nameDisplay.label": "Название ключа",
  "wizard.nameDisplay.number": "Номер ключа",
  "wizard.nameDisplayPreview": "В клиенте: {value}",
  "wizard.server": "Сервер",
  "wizard.serverPlaceholder": "Выберите сервер",
  "wizard.serverQuota": "ключей {used}/{limit}",
  "wizard.serverQuotaHint":
    "Лимит ключей считается по каждому серверу отдельно. Сервер, где лимит уже выбран, выбрать нельзя.",
  "wizard.serverFull": "На этом сервере лимит ключей уже исчерпан.",
  "wizard.protocol": "Протокол",
  "wizard.protocolHint":
    "AmneziaWG 3.1 маскирует заголовки и добавляет случайные трейлеры — сложнее обнаружить. 2.0 оставлен для старых клиентов.",
  "wizard.routing": "Маршрутизация",
  "wizard.routingHint":
    "Определяет, какой трафик идёт через VPN. Профиль вшивается в ключ при создании — позже его можно сменить только перевыпуском.",
  "wizard.routingLocked":
    "Администратор разрешил только «Весь трафик». Остальные профили недоступны.",
  "wizard.creating": "Создаём…",
  "wizard.create": "Создать ключ",

  // Config download dialog
  "config.qrSmall": "маленький",
  "config.qrMedium": "средний",
  "config.qrLarge": "большой",
  "config.keyCopied": "Ключ скопирован",
  "config.copyFailed": "Не удалось скопировать",
  "config.title": "Ключ: {label}",
  "config.desc":
    "Вставьте ссылку в AmneziaVPN («Подключиться по ссылке») или отсканируйте QR-код камерой телефона.",
  "config.loadFailed": "Не удалось загрузить ключ.",
  "config.connectionKey": "Ключ подключения (vpn://)",
  "config.done": "Готово",
  "config.copy": "Копировать",
  "config.qr": "QR-код",
  "config.qrSizeAria": "Размер QR-кода",
  "config.qrSizeItemAria": "Размер: {size}",
  "config.qrAlt": "QR-код для подключения",
  "config.qrHint": "Наведите камеру телефона на код",
  "config.qrUnavailableTitle": "QR-код недоступен для этого профиля",
  "config.qrUnavailableBody":
    "В профилях с раздельным туннелированием слишком много маршрутов, чтобы отобразить QR-код. Удобнее всего использовать конфиг-файл выше — скопируйте ключ и вставьте его в вашем клиенте (Добавить → Из строки/файла). Работа ключа на таких профилях не гарантируется.",

  // Install guide dialog (user page)
  "install.button": "Как подключиться",
  "install.title": "Установка AmneziaVPN и подключение",
  "install.desc":
    "Установите приложение, добавьте ключ — и посмотрите, что делать, если подключение не работает.",
  "install.opensNewTab": "Откроется в новой вкладке",
  "install.latestVersion": "Последняя версия: {version}",
  "install.linksUnavailable":
    "Не удалось получить ссылки на приложение. Обновите страницу или попробуйте позже.",
  "install.linksStale":
    "Не удалось проверить последний выпуск. Кнопки ведут на страницу выпусков — выберите там файл для своей системы.",

  "install.installTitle": "Установите приложение",
  "install.platform.windows": "Windows",
  "install.platform.macos": "macOS",
  "install.platform.android": "Android",
  "install.platform.ios": "iPhone и iPad",
  "install.pickFile": "Выберите файл для своей системы",
  "install.desktopNote":
    "Кнопки Windows и macOS скачивают установщик последнего выпуска. Запустите скачанный файл и следуйте установщику.",
  "install.iosNote":
    "В App Store приложение называется DefaultVPN, а не Amnezia. Это официальный клиент от тех же разработчиков, ставьте именно его.",
  "install.iosProfileWarning":
    "На iPhone и iPad работает ключ без профиля маршрутизации — весь трафик идёт через VPN. Ключ с профилем («Иностранные ресурсы через VPN», «Только заблокированные сайты») на iPhone и iPad подключается, но правила не применяются: весь трафик идёт напрямую, мимо VPN, и приложение об этом не предупреждает. Для iPhone и iPad создавайте ключ без профиля маршрутизации, а ключи с профилями используйте на Windows, macOS и Android.",
  "install.versionNote":
    "Ключи AmneziaWG 3.1 работают только в клиенте версии {version} или новее.",
  "install.apkTitle": "Google Play не открывается или установка не проходит?",
  "install.apkIntro":
    "Установите приложение из APK — это официальный установочный файл AmneziaVPN со страницы выпусков проекта.",
  "install.apkStep1": "Нажмите кнопку ниже и дождитесь окончания загрузки.",
  "install.apkStep2":
    "Откройте скачанный файл: из шторки загрузок или через «Файлы» → «Загрузки».",
  "install.apkStep3":
    "Если Android попросит — разрешите установку из этого источника («Разрешить установку неизвестных приложений» для браузера или файлового менеджера) и вернитесь назад.",
  "install.apkStep4": "Нажмите «Установить», затем «Открыть».",
  "install.apkDownload": "Скачать APK",
  "install.apkOtherBuilds":
    "Другое устройство (32-битное или Android 9-10)? Выберите нужный файл на странице выпуска.",

  "install.addTitle": "Добавьте ключ",
  "install.addStep1":
    "Скопируйте ключ подключения (vpn://…) на карточке ключа — кнопка «Копировать».",
  "install.addStep2": "Откройте AmneziaVPN и нажмите «+» (добавить сервер).",
  "install.addStep3":
    "Выберите «Вставить» (ключ подключения) и вставьте скопированный ключ.",
  "install.addStep4": "Нажмите «Подключиться».",
  "install.addResult":
    "Сервер появится в списке приложения под тем же именем, что и в панели, и приложение подключится к нему.",

  "install.confTitle": "Файл .conf — удобнее для профилей с маршрутизацией",
  "install.confBody":
    "Кнопка «Скачать .conf» на карточке ключа даёт файл конфигурации. Его не вставляют как текст — его импортируют как файл.",
  "install.confSplitBest":
    "Для профилей «Иностранные ресурсы через VPN» и «Только заблокированные сайты» это лучший вариант на Windows, macOS и Android: ключ подключения там очень длинный, QR-код недоступен, а файл переносится и импортируется одним действием. Список подсетей маршрутизации в файле сохраняется полностью.",
  "install.confIosWarning":
    "К iPhone и iPad это не относится: там ключ с профилем маршрутизации подключается, но правила не применяются — ни через файл, ни через ключ подключения. На iPhone и iPad используйте ключ без профиля маршрутизации.",
  "install.confAmneziaTitle": "В AmneziaVPN",
  "install.confAmneziaStep1": "Скачайте файл .conf на карточке ключа.",
  "install.confAmneziaStep2":
    "Откройте AmneziaVPN, нажмите «+» и выберите импорт файла конфигурации.",
  "install.confAmneziaStep3":
    "Укажите скачанный файл и нажмите «Подключиться». На телефоне проще открыть файл и передать его в AmneziaVPN через «Поделиться».",
  "install.confOtherTitle": "В другом клиенте",
  "install.confOtherBody":
    "Файл понимают клиенты с поддержкой AmneziaWG: awg-quick из amneziawg-tools, приложение AmneziaWG для Android, роутеры с пакетом amneziawg. Импортируйте файл как обычный туннель.",
  "install.confStockWarning":
    "Обычный клиент WireGuard такой файл не примет: в нём есть параметры маскировки AmneziaWG (Jc, S1, H1 и другие), которых в WireGuard нет. Нужен AmneziaVPN или клиент с поддержкой AmneziaWG.",
  "install.confDomainsWarning":
    "Файл несёт диапазоны адресов, но не правила, записанные именем сайта. В профиле «Только заблокированные сайты» такой сайт не пойдёт через VPN и останется недоступен. В профиле «Всё, кроме…» — наоборот, пойдёт через VPN, а не мимо него. Подключение в обоих случаях рабочее: не применяется только это правило. Если это важно, добавьте ключ подключения в AmneziaVPN вместо файла.",

  "install.fixTitle": "Если не работает",
  "install.fixServer":
    "Попробуйте другой сервер: создайте ключ на другом сервере из списка.",
  "install.fixFullTunnel":
    "Попробуйте ключ без профиля маршрутизации (весь трафик через VPN) — так видно, дело в сети или в правилах.",
  "install.fixUpdate":
    "Обновите AmneziaVPN и делайте это регулярно: устаревший клиент — частая причина, по которой ключ AmneziaWG 3.1 не подключается.",
  "install.checkUpdates": "Страница последнего выпуска",

  // Quota request dialog
  "quota.sent": "Запрос отправлен администратору",
  "quota.sendFailed": "Не удалось отправить запрос",
  "quota.title": "Дополнительные ключи",
  "quota.desc": "Запросите увеличение лимита ключей у администратора.",
  "quota.additional": "Сколько ещё слотов под ключи запросить",
  "quota.target": "Для какого сервера",
  "quota.targetAll": "Все серверы",
  "quota.currentLimit": "Сейчас доступно: {limit}",
  "quota.willBecome": "Станет {total} на каждом сервере",
  "quota.willBecomeNode": "Станет {total} на сервере «{node}»",
  "quota.reason": "Обоснование",
  "quota.reasonPlaceholder":
    "Опишите, зачем нужны дополнительные ключи (не менее 10 символов).",
  "quota.reasonOptional": "Необязательно, но желательно кратко пояснить.",
  "quota.sending": "Отправляем…",
  "quota.submit": "Отправить запрос",

  // Traffic
  "traffic.rangeToday": "Сегодня",
  "traffic.range7": "7 дней",
  "traffic.range30": "Месяц",
  "traffic.noData": "Нет данных о трафике за период",
  "traffic.none": "Трафика ещё не было",
  "traffic.total": "Всего: ",
  "traffic.received": "Принято",
  "traffic.sent": "Отправлено",

  // Node select
  "nodeSelect.allNodes": "Доступны все ноды",
  "nodeSelect.noNodes": "Нет доступных нод",

  // Protocol select
  "protoSelect.recommended": "рекомендуется",
  "protoSelect.legacy": "legacy",
  "protoSelect.unsupported": "не поддерживается",

  // Admin data (toasts)
  "adminData.actionDone": "Действие выполнено",
  "adminData.actionFailed": "Ошибка выполнения действия",

  // Admin overview
  "ov.stateActive": "Активные",
  "ov.stateDisabled": "Отключённые",
  "ov.stateProvisioning": "Создаются",
  "ov.stateRevoking": "Отзываются",
  "ov.stateRevoked": "Отозванные",
  "ov.stateFailed": "С ошибкой",
  "ov.activeKeys": "Активные ключи",
  "ov.onlineNow": "Онлайн сейчас",
  "ov.totalTraffic": "Суммарный трафик",
  "ov.users": "Пользователи",
  "ov.usersSub": "{active} активных · {disabled} отключено",
  "ov.nodesHealthy": "Ноды (в норме)",
  "ov.quotaRequests": "Запросы лимита",
  "ov.byProtocol": "По протоколу",
  "ov.byRouting": "По маршрутизации",
  "ov.byStatus": "По статусу",
  "ov.trafficSummary": "Трафик за период",
  "ov.serversTitle": "Серверы",
  "ov.noServers": "Серверы ещё не добавлены",
  "ov.inactiveTitle": "Неактивны более {days} дней",
  "ov.showAll": "Показать всех",
  "ov.allActiveSeen":
    "Все активные пользователи выходили на связь за последние {days} дней.",
  "ov.quotaReqTitle": "Запросы на увеличение лимита",
  "ov.colEmployee": "Сотрудник",
  "ov.colTarget": "Сервер",
  "ov.quotaTargetAll": "Все серверы",
  "ov.quotaReplacesPerNode":
    "Одобрение заменит персональные лимиты по серверам ({count}).",
  "ov.colNewLimit": "Новый лимит",
  "ov.colLimitChange": "Лимит: сейчас → запрос",
  "ov.colReason": "Обоснование",
  "ov.colDate": "Дата",
  "ov.approve": "Одобрить",
  "ov.reject": "Отклонить",
  "ov.noRequests": "Новых запросов на расширение лимита нет",

  // Admin users
  "users.deact.admin_offboard": "отключён вручную",
  "users.deact.access_removed": "доступ Cloudflare отозван",
  "upolicy.allowKeyCreation": "Создание ключей",
  "upolicy.allowNodeSelection": "Выбор ноды",
  "upolicy.allowRouteProfileSelection": "Выбор маршрутизации",
  "upolicy.allowCustomRoutes": "Свои маршруты",
  "upolicy.allowConfigRedownload": "Повторная загрузка",
  "upolicy.allowQrDownload": "QR-коды",
  "upolicy.allowConfDownload": "Скачивание .conf",
  "upolicy.allowSelfRevoke": "Самостоятельный отзыв",
  "upolicy.showLastUsed": "Дата активности",
  "upolicy.showTraffic": "Объём трафика",
  "users.filter.all": "Все",
  "users.filter.inactive": "Неактивные ({days}д)",
  "users.filter.online": "Онлайн сейчас",
  "users.filter.nokeys": "Без ключей",
  "users.filter.admins": "Администраторы",
  "users.filter.disabled": "Отключённые",
  "users.sort.name": "По имени",
  "users.sort.activity": "По активности",
  "users.sort.keys": "По числу ключей",
  "users.sort.traffic": "По трафику",
  "users.title": "Пользователи и ключи",
  "users.summary": "{users} польз. · {keys} ключей",
  "users.summaryShown": " · показано {shown}",
  "users.searchPlaceholder": "Поиск по имени или e-mail…",
  "users.addBtn": "Пользователь",
  "users.noUsers": "Пользователей пока нет",
  "users.selectLeft": "Выберите пользователя слева",
  "users.added": "Пользователь добавлен",
  "users.addFailed": "Не удалось добавить",
  "users.roleAdminLabel": "назначить администратором",
  "users.roleRemoveLabel": "снять роль",
  "users.roleConfirm": "Точно {label} {email}?",
  "users.offboardConfirm":
    "Отключить и удалить {email}? Все ключи будут отозваны, аккаунт удаляется после их отзыва.",
  "users.keysWord": "ключей",
  "users.onlineCount": "{count} онлайн",
  "users.limitNode": "Лимит ключей:",
  "users.default": "по умолч.",
  "users.policies": "Политики",
  "users.removeAdmin": "Снять админа",
  "users.makeAdmin": "Сделать админом",
  "users.reinstate": "Восстановить",
  "users.delete": "Удалить",
  "users.statKeys": "Ключей",
  "users.statActive": "Активных",
  "users.statOnline": "Онлайн",
  "users.statTraffic": "Трафик",
  "users.keys": "Ключи",
  "users.keysHint":
    "Управление ключами пользователя: отключить приостанавливает доступ обратимо, отозвать удаляет пира навсегда.",
  "users.keyBtn": "Ключ",
  "users.noUserKeys": "У пользователя ещё нет ключей",
  "users.online": "Онлайн",
  "users.offline": "Оффлайн",
  "users.rulesOutdatedTip": "Правила обновились — нужен перевыпуск",
  "users.disable": "Отключить",
  "users.disableConfirm": "Отключить «{label}»?",
  "users.enable": "Включить",
  "users.enableConfirm": "Включить «{label}»?",
  "users.exportConfig": "Экспорт конфигурации",
  "users.revoke": "Отозвать",
  "users.revokeConfirm": "Отозвать «{label}» безвозвратно?",
  "users.newUser": "Новый пользователь",
  "users.newUserDesc":
    "Пользователь входит по своему e-mail через Cloudflare Access.",
  "users.email": "E-mail",
  "users.emailPlaceholder": "ivan@company.ru",
  "users.nameOptional": "Имя (необязательно)",
  "users.namePlaceholder": "Иван Петров",
  "users.role": "Роль",
  "users.roleHint": "Администратор видит эту панель и управляет всеми ключами.",
  "users.limitTitle": "Серверы и лимиты ключей",
  "users.limitDesc": "{email} — доступные серверы и лимит ключей на каждом",
  "users.limitLabel": "Лимит по умолчанию на каждом сервере",
  "users.limitLabelHint": "Пусто — глобальный лимит ({value}).",
  "users.limitAllNodes": "Доступны все серверы",
  "users.limitAllNodesHint":
    "Выключите, чтобы выбрать серверы именно для этого пользователя. Включено — действует глобальный список.",
  "users.limitGlobalNodes": "Глобально доступны: {nodes}",
  "users.limitNoneWord": "нет серверов",
  "users.limitPerNode": "Серверы",
  "users.limitPerNodeHint":
    "Галочка — сервер доступен пользователю. Число — лимит ключей на этом сервере; пусто — лимит по умолчанию.",
  "users.limitPerNodeAria": "Лимит ключей на сервере {node}",
  "users.limitColumnLimit": "Лимит",
  "users.limitNoNodesWarning":
    "Не выбран ни один сервер — пользователь не сможет создать ключ.",
  "users.policyTitle": "Индивидуальные политики",
  "users.policyDesc": "{email} — переопределяют глобальные настройки",
  "users.customProtocols": "Свой набор протоколов",
  "users.customProtocolsHint":
    "Иначе пользователь видит глобальный набор ({protocols}).",
  "users.nodesMovedHint":
    "Доступные серверы и лимиты по серверам настраиваются в «Серверы и лимиты ключей».",
  "users.savePolicies": "Сохранить политики",
  "users.keyForTitle": "Ключ для {email}",
  "users.keyForDesc": "Протокол выбирается автоматически: {protocol}",
  "users.nodeDisabledSuffix": " (выключена)",
  "users.routeHintAdmin":
    "Профиль вшивается в ключ. Для «зарубежных» и «заблокированных» нужны активные списки маршрутизации.",
  "users.keyCreatedHint":
    "Ключ создаётся на сервере — устройство подключится сразу после импорта конфигурации.",

  // Admin nodes
  "nodes.cap.peerLifecycle": "Ключи",
  "nodes.cap.telemetry": "Телеметрия",
  "nodes.cap.backup": "Бэкап",
  "nodes.enabled": "Нода включена",
  "nodes.disabled": "Нода отключена",
  "nodes.changeFailed": "Не удалось изменить",
  "nodes.deleteConfirm": "Удалить ноду «{name}»? Действие необратимо.",
  "nodes.deleted": "Нода удалена",
  "nodes.deleteFailed": "Не удалось удалить ноду",
  "nodes.deleteTitle": "Удаление ноды «{name}»",
  "nodes.deleteWithKeys":
    "Вместе с нодой будут безвозвратно удалены все выпущенные на ней ключи. Отменить это нельзя.",
  "nodes.deleteImpact":
    "Будет удалено ключей: {keys} — включая отозванные. Затронуто пользователей: {users}.",
  "nodes.deleteImpactStates": "Из них активных: {active}, остальных: {other}.",
  "nodes.deletePeersTitle": "Пиры на сервере продолжат работать",
  "nodes.deletePeersBody":
    "Панель удаляет ключи только из своей базы — обратиться к удаляемой ноде она уже не может. Конфигурации пиров останутся в контейнерах AmneziaWG на самом сервере: если сервер продолжает работать, эти конфигурации будут работать, пока сервер не выключат или не очистят вручную.",
  "nodes.deleteTypeName": "Введите внутреннее название ноды, чтобы подтвердить",
  "nodes.deleteTypeNameHint": "Ровно так: {name}",
  "nodes.deleteAction": "Удалить ноду",
  "nodes.deleteActionKeys": "Удалить ноду и ключи",
  "nodes.deleting": "Удаляем…",
  "nodes.deletedWithKeys":
    "Нода «{name}» удалена. Ключей удалено: {keys}, затронуто пользователей: {users}.",
  "nodes.titleHint":
    "Нода — это сервер с node-agent, на котором создаются VPN-ключи. Панель управляет ими через защищённый API.",
  "nodes.summary": "{total} серв. · {enabled} включено",
  "nodes.addNode": "Добавить ноду",
  "nodes.empty": "Нет ни одной ноды",
  "nodes.emptyHint":
    "Добавьте сервер с node-agent, чтобы начать выпускать ключи.",
  "nodes.commError": "Ошибка связи",
  "nodes.working": "В работе",
  "nodes.stopped": "Отключена",
  "nodes.toggleOff": "Отключить ноду",
  "nodes.toggleOn": "Включить ноду",
  "nodes.toggleOffTip": "Отключить приём новых ключей",
  "nodes.toggleOnTip": "Включить ноду",
  "nodes.protoActive": "Активен",
  "nodes.protoSupported": "Поддерживается, но выключен",
  "nodes.capacity": "Ёмкость",
  "nodes.traffic": "Трафик",
  "nodes.healthCheck": "Проверка:",
  "nodes.sync": "Синхрон.:",
  "nodes.reconcile": "Сверка",
  "nodes.edit": "Изменить",
  "nodes.deleteAria": "Удалить ноду",
  "nodes.deleteTip": "Удалить ноду — ключей на ней нет",
  "nodes.deleteTipKeys": "Удалить ноду вместе со всеми её ключами ({keys})",
  "nodes.added": "Нода добавлена",
  "nodes.addFailed": "Не удалось добавить ноду",
  "nodes.createTitle": "Добавить VPN-ноду",
  "nodes.createDesc":
    "API-ключ сохраняется зашифрованным и больше не показывается.",
  "nodes.updated": "Нода обновлена",
  "nodes.updateFailed": "Не удалось обновить ноду",
  "nodes.editTitle": "Редактировать ноду",
  "nodes.editDesc": "Оставьте API-ключ пустым, чтобы сохранить текущий.",
  "nodes.enabledToggle": "Нода включена",
  "nodes.internalName": "Внутреннее название",
  "nodes.internalNameHint": "Видно только администраторам",
  "nodes.publicName": "Название для пользователей",
  "nodes.publicNameHint":
    "Как пользователи видят этот сервер. Пусто — берётся внутреннее название.",
  "nodes.publicNamePlaceholder": "Напр. Нидерланды",
  "nodes.seenAs": "Пользователи видят: {name}",
  "nodes.agentAddr": "Адрес node-agent",
  "nodes.agentHint":
    "URL агента amnezia-api на сервере: прямой https://СЕРВЕР:ПОРТ либо http://host.docker.internal:4001 через SSH-туннель",
  "nodes.apiKeyRequired": "API-ключ (не менее 32 символов)",
  "nodes.apiKeyNew": "Новый API-ключ",
  "nodes.apiKeyNewHint": "Оставьте пустым, чтобы не менять текущий ключ",
  "nodes.protocols": "Протоколы ноды",
  "nodes.protocolsHint": "Какие протоколы нода предлагает пользователям",
  "nodes.peerLimit": "Лимит peer",

  // Admin policy
  "gpolicy.allowKeyCreation": "Создание ключей",
  "gpolicy.allowNodeSelection": "Выбор VPN-ноды",
  "gpolicy.allowRouteProfileSelection": "Выбор профиля маршрутизации",
  "gpolicy.allowCustomRoutes": "Пользовательские маршруты",
  "gpolicy.allowConfigRedownload": "Повторная загрузка конфигураций",
  "gpolicy.allowQrDownload": "Отображение QR-кодов",
  "gpolicy.allowConfDownload": "Скачивание .conf файлов",
  "gpolicy.allowSelfRevoke": "Самостоятельный отзыв ключей",
  "gpolicy.showPublicKey": "Показывать публичный ключ",
  "gpolicy.showLastUsed": "Показывать дату активности",
  "gpolicy.showTraffic": "Показывать объём трафика",
  "gpolicy.allowKeyCreationHint":
    "Пользователь может сам создавать новые ключи для своих устройств.",
  "gpolicy.allowNodeSelectionHint":
    "Пользователь может выбирать, на каком сервере (ноде) создать ключ.",
  "gpolicy.allowRouteProfileSelectionHint":
    "Пользователь может выбирать профиль маршрутизации: весь трафик, только зарубежные или только заблокированные сайты.",
  "gpolicy.allowCustomRoutesHint":
    "Пользователь может добавлять свои домены и IP в списки whitelist/blacklist своего профиля.",
  "gpolicy.allowConfigRedownloadHint":
    "Пользователь может повторно скачать конфиг уже созданного ключа.",
  "gpolicy.allowQrDownloadHint":
    "Пользователь может получить QR-код для быстрого подключения.",
  "gpolicy.allowConfDownloadHint":
    "Пользователь может скачать .conf-файл ключа.",
  "gpolicy.allowSelfRevokeHint":
    "Пользователь может сам отзывать (удалять) свои ключи.",
  "gpolicy.showPublicKeyHint":
    "Показывать публичный ключ устройства в карточке ключа.",
  "gpolicy.showLastUsedHint":
    "Показывать время последнего использования ключа.",
  "gpolicy.showTrafficHint":
    "Показывать объём трафика (получено/отдано) по ключу.",
  "policy.title": "Глобальная политика портала",
  "policy.keyLimit": "Лимит ключей на ноду",
  "policy.keyLimitHint":
    "Сколько ключей по умолчанию доступно пользователю на каждой ноде. Для отдельного человека лимит можно переопределить.",
  "policy.retention": "Срок хранения истории (дней)",
  "policy.retentionHint":
    "Сколько дней хранить посуточную статистику трафика; более старые записи удаляются.",
  "policy.cfAccountIdHint":
    "ID аккаунта Cloudflare (Zero Trust → Settings → General).",
  "policy.cfAppIdHint":
    "ID приложения Access, которое защищает вход в панель.",
  "policy.cfPolicyIdHint":
    "ID allow-политики, чей список email синхронизируется с активными пользователями панели.",
  "policy.cfTokenHint":
    "API-токен Cloudflare с правом Access: Apps and Policies — Edit. Хранится зашифрованным; показывается только заглушка, ввод заменяет токен.",
  "policy.defaultProtocols": "Протоколы по умолчанию",
  "policy.defaultProtocolsHint":
    "Какие протоколы предлагаются всем при создании ключа. Сейчас используется только AWG 3.1; AWG 2.0 можно включить обратно здесь, на конкретной ноде или для отдельного пользователя.",
  "policy.availableNodes": "Доступные ноды",
  "policy.availableNodesHint":
    "На каких нодах пользователи могут создавать ключи. Отдельным пользователям можно назначить свой набор в их политиках.",
  "policy.employeePerms": "Разрешения для сотрудников",
  "policy.telemetryDisplay": "Отображение телеметрии",
  "policy.cfAccessHint":
    "Для двусторонней синхронизации пользователей с Access. API-токен хранится зашифрованным и не показывается — можно только заменить. См. docs/CLOUDFLARE-ACCESS.md.",
  "policy.cfToken": "API-токен (Access: Apps and Policies — Edit)",
  "policy.cfTokenSet": "•••••••••• — задан, введите новый чтобы заменить",
  "policy.cfTokenPlaceholder": "Вставьте токен",
  "policy.saveGlobal": "Сохранить глобальные политики",
  "common.saving": "Сохраняем…",

  // Admin audit
  "audit.subtitle": "История действий · {count} записей",
  "audit.searchPlaceholder": "Поиск по событию…",
  "audit.empty": "Журнал пуст",
  "audit.system": "Система",
  "audit.verb.create": "добавил",
  "audit.verb.create-key": "создал ключ",
  "audit.verb.disable": "отключил",
  "audit.verb.enable": "включил",
  "audit.verb.revoke": "отозвал",
  "audit.verb.offboard": "отключил пользователя",
  "audit.verb.reinstate": "восстановил пользователя",
  "audit.verb.set-limit": "изменил лимит",
  "audit.verb.set-policy": "изменил политики",
  "audit.verb.set-role": "изменил роль",
  "audit.verb.reconcile": "синхронизировал",
  "audit.verb.update": "обновил",
  "audit.verb.activate": "активировал",
  "audit.verb.seed": "загрузил списки",
  "audit.verb.approve": "одобрил запрос",
  "audit.verb.reject": "отклонил запрос",
  "audit.res.users": "пользователя",
  "audit.res.keys": "ключ",
  "audit.res.nodes": "ноду",
  "audit.res.quota-requests": "запрос лимита",
  "audit.res.portal-policy": "глобальные политики",
  "audit.res.rules": "правила маршрутизации",
  "audit.exact.vpn_key.create_requested": "запросил создание ключа",
  "audit.exact.vpn_key.revoke_requested": "запросил отзыв ключа",
  "audit.exact.vpn_key.rotate_requested": "запросил перевыпуск ключа",
  "audit.exact.vpn_key.private_config_viewed": "просмотрел приватный конфиг",
  "audit.exact.node.created": "добавил ноду",
  "audit.exact.node.updated": "обновил ноду",
  "audit.exact.node.deleted": "удалил ноду",
  "audit.exact.node.reconcile": "синхронизировал ноду",
  "audit.exact.quota_request.created": "создал запрос на лимит",
  "audit.exact.user.access_revoked": "деактивирован — доступ Cloudflare отозван",
  "audit.exact.user.deleted": "удалён (после отзыва ключей)",
  "audit.exact.admin.users.create": "добавил пользователя",
  "audit.exact.admin.users.create-key": "создал ключ пользователю",
  "audit.exact.admin.portal-policy.update": "обновил глобальные политики",
  "audit.exact.admin.rules.activate": "активировал правила маршрутизации",
  "audit.exact.admin.nodes.reconcile": "синхронизировал ноду",
  "audit.target.vpn_key": "ключ",
  "audit.target.user": "пользователь",
  "audit.target.node": "нода",
  "audit.target.portal_policy": "политики",
  "audit.target.route_rule": "правила",
  "audit.target.rule_version": "правила",
  "audit.target.quota_request": "запрос",

  // Admin rules
  "rules.status.active": "Активно",
  "rules.status.superseded": "Заменено",
  "rules.status.quarantined": "Карантин",
  "rules.title": "Правила маршрутизации (RoscomVPN)",
  "rules.autoUpdate":
    "Списки обновляются автоматически каждые 6 часов из настроенных источников (RULE_FEEDS).",
  "rules.colProfile": "Профиль",
  "rules.colVersion": "Версия",
  "rules.colSubnets": "Подсети / Домены",
  "rules.colStatus": "Статус",
  "rules.colPublished": "Опубликовано",
  "rules.cidrDomains": "CIDR: {cidr} · Доменов: {domains}",
  "rules.notActive": "Не активно",
  "rules.viewAria": "Просмотр правил",
  "rules.viewTitle": "Просмотр и сравнение",
  "rules.activate": "Активировать",
  "rules.empty": "Версии правил пока не загружены.",
  "rules.refresh": "Проверить обновления",
  "rules.refreshQueued": "В очереди…",
  "rules.refreshRunning": "Проверяем…",
  "rules.refreshUnchanged": "Проверено, изменений нет",
  "rules.refreshUpdated": "Загружена новая версия списков",
  "rules.refreshFailed": "Не удалось проверить обновления",
  "rules.refreshFailedWith": "Не удалось проверить обновления: {error}",
  "rules.refreshTimeout":
    "Проверка идёт дольше обычного — обновите страницу чуть позже",

  // Admin global routes
  "groutes.title": "Глобальные маршруты",
  "groutes.subtitle":
    "Общие дополнения и исключения поверх списков RoscomVPN — применяются ко всем пользователям.",
  "groutes.hint":
    "Записи применяются при следующем экспорте конфигурации. Сначала убираются исключения, затем добавляются глобальные записи, и последними — собственные маршруты пользователя.",
  "groutes.count": "Записей: {count}",
  "groutes.expand": "Открыть",
  "groutes.collapse": "Свернуть",
  "groutes.unsaved": "Есть несохранённые изменения",
  "groutes.add": "Добавить маршруты",
  "groutes.addHint":
    "Дополнительные подсети и домены, которые попадут в список выбранного профиля у каждого пользователя.",
  "groutes.exclude": "Исключить из списков RoscomVPN",
  "groutes.excludeHint":
    "Подсети и домены, которые убираются из списка до его выдачи. Исключение домена убирает и все его поддомены. Если пользователь добавит ту же запись в свои маршруты, она вернётся — личные маршруты имеют приоритет.",
  "groutes.save": "Сохранить маршруты",

  // Rule preview dialog
  "rpd.loadFailed": "Не удалось загрузить",
  "rpd.compareFailed": "Не удалось сравнить версии",
  "rpd.title": "Правила: {profile}",
  "rpd.version": "Версия",
  "rpd.cidrBadge": "CIDR: {count}",
  "rpd.domainsBadge": "Домены: {count}",
  "rpd.compareActive": "Сравнить с активной версией",
  "rpd.showDiff": "Показать различия",
  "rpd.cidrTitle": "CIDR",
  "rpd.domains": "Домены",
  "rpd.subnetsCidr": "Подсети (CIDR)",

  // Admin config export dialog
  "acfg.title": "Экспорт конфигурации",
  "acfg.warning":
    "Просмотр чужих конфигураций фиксируется в журнале аудита с вашим идентификатором.",
  "acfg.confirmLabel": "Подтверждаю служебную необходимость экспорта",
  "acfg.fetchFailed": "Не удалось получить конфигурацию",
  "acfg.copied": "Скопировано",
} as const;

const en = {
  // Language switch
  "lang.switch": "Switch language",

  // Theme toggle
  "theme.light": "Light theme",
  "theme.dark": "Dark theme",

  // Shared
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.add": "Add",
  "common.adding": "Adding…",
  "common.save": "Save",
  "common.name": "Name",
  "common.actions": "Actions",
  "common.noData": "No data",
  "common.notFound": "Nothing found",
  "common.loadFailed": "Failed to load data",
  "common.downloadConf": "Download .conf",

  // Roles
  "role.user": "User",
  "role.admin": "Administrator",

  // Hint
  "hint.aria": "Hint",

  // Admin navigation / shell
  "nav.overview": "Overview",
  "nav.users": "Users",
  "nav.nodes": "VPN nodes",
  "nav.policy": "Policies",
  "nav.rules": "Routing",
  "nav.audit": "Audit log",
  "nav.logout": "Sign out",
  "admin.myKeys": "My keys",
  "admin.version": "Version",
  "admin.title": "VPN management",

  // Direct login page (server-side Google, when not behind Cloudflare)
  "login.title": "Sign in to the panel",
  "login.subtitle": "",
  "login.google": "Sign in",
  "login.notAllowed":
    "This account is not on the allowlist. Ask an administrator to add you.",
  "login.unavailable": "The service is temporarily unavailable. Try again.",
  "login.failed": "Sign-in failed. Please try again.",
  "login.logout": "Sign out",

  // Panel self-update (admin overview)
  "update.title": "Panel update",
  "update.current": "Current version",
  "update.built": "built",
  "update.commit": "commit",
  "update.button": "Update panel",
  "update.confirmTitle": "Update the panel?",
  "update.confirmBody":
    "The panel will pull a fresh image, run database migrations and restart. A short access interruption is possible (~1 minute). The database is backed up automatically before the update.",
  "update.confirm": "Update",
  "update.running": "Update in progress…",
  "update.runningHint":
    "The panel may become briefly unreachable and then come back. You can simply reload this page in a minute.",
  "update.scheduled": "Update started",
  "update.requestedBy": "requested by",
  "update.lastOk": "The last update succeeded",
  "update.lastFail": "The last update failed",
  "update.disabled": "The update mechanism is not installed on the host",
  "update.disabledHint":
    "Install the host worker once: sudo bash infra/prod/install-updater.sh",

  // Route profiles (shared)
  "route.full_tunnel": "All traffic",
  "route.ru_whitelist": "Foreign only (whitelist)",
  "route.ru_blacklist": "Blocked only (blacklist)",

  // Protocols (shared)
  "protocol.awg2": "AWG 2.0",
  "protocol.awg3": "AWG 3.1",

  // Key states (status badge)
  "status.provisioning": "Provisioning",
  "status.active": "Active",
  "status.disabled": "Disabled",
  "status.revoking": "Revoking",
  "status.revoked": "Revoked",
  "status.failed": "Error",

  // Device types
  "device.base": "Device",
  "device.unspecified": "Unspecified",
  "device.android": "Android",
  "device.ios": "iPhone iPad",
  "device.macos": "macOS MacBook",
  "device.windows": "Windows PC",
  "device.linux": "Linux",
  "device.other": "Other",
  "device.name.android": "Android",
  "device.name.ios": "iPhone",
  "device.name.macos": "Mac",
  "device.name.windows": "PC",
  "device.name.linux": "Linux",

  // Employee dashboard
  "emp.title": "My VPN keys",
  "emp.loadingProfile": "Loading profile…",
  "emp.admin": "Administration",
  "emp.refresh": "Refresh",
  "emp.quotaUsage": "Key limit",
  "emp.quotaPerNode": "Up to {limit} on each server",
  "emp.requestMore": "Request more",
  "emp.devices": "Devices",
  "emp.newKey": "New key",
  "emp.noKeys": "No keys yet",
  "emp.noKeysHint":
    "Create a separate key for your computer or phone — it only takes a couple of seconds.",
  "emp.createFirst": "Create your first key",
  "routes.sectionTitle": "Adding rules to a profile",
  "routes.title": "Custom routes",
  "routes.subtitle": "Extra addresses layered on the base lists",
  "routes.hint":
    "Add your own domains and IPs — they go through the VPN together with the selected profile's base list. The base list is hidden and applied automatically. Changes take effect on your next config export.",
  "routes.count": "{count} total",
  "routes.ipLabel": "IP addresses & subnets",
  "routes.ipPlaceholder": "e.g. 1.2.3.4 or 10.0.0.0/8",
  "routes.domainLabel": "Domains",
  "routes.domainPlaceholder": "e.g. example.com",
  "routes.save": "Save routes",
  "routes.saving": "Saving…",
  "routes.saved": "Routes saved",
  "routes.saveFailed": "Could not save routes",
  "routes.badIp": "Invalid IP or subnet",
  "routes.badDomain": "Invalid domain",
  "routes.removeAria": "Remove {value}",
  "routes.profileHint":
    "Choose which profile to add addresses to. A key's profile is set when it's created — your addresses apply to keys using that profile.",
  "routes.wl.desc":
    "Foreign only: foreign resources go through the VPN, Russian ones stay direct. The addresses you add also go through the VPN.",
  "routes.bl.desc":
    "Blocked only: only blocked sites go through the VPN. The addresses you add also go through the VPN.",
  "emp.keyCreated": "Key created",
  "emp.rotateConfirm":
    "Reissue the key with the current rules? The old config will stop working — you will need to paste the new key on the device.",
  "emp.rotateToast":
    "The key is being updated. When the status turns “Active”, open “Show key” and paste the new one.",
  "emp.rotateFailed": "Failed to update the key",
  "emp.revokeConfirm":
    "Revoke this key? The device will immediately lose access.",
  "emp.revoked": "Key revoked",
  "emp.revokeFailed": "Failed to revoke the key",
  "quota.cellsAria": "{used} of {limit} keys",
  "quota.cellIssued": "Key issued",
  "quota.cellFree": "Free slot",

  // Key card
  "keyCard.rulesUpdatedTitle": "Routing rules have changed",
  "keyCard.updateKey": "Update key",
  "keyCard.rulesUpdatedBody":
    "Reissue the key to apply the new rules. The old config will stop working — reinstall the key on the device.",
  "keyCard.created": "Created: ",
  "keyCard.traffic": "Traffic: ",
  "keyCard.reissue": "Reissue",
  "keyCard.reissueTip":
    "Issue a new key with the current rules. The old one will stop working — reinstall the config on the device.",
  "keyCard.provisioning": "Creating…",
  "keyCard.showQr": "Show QR code",
  "keyCard.qrAndLink": "QR code and link",
  "keyCard.revoke": "Revoke key",
  "keyCard.copy": "Copy key",
  "keyCard.copying": "Copying…",
  "keyCard.copied": "Copied",
  "keyCard.copyFail": "Failed",
  "keyCard.copyToast": "Key copied — paste it into AmneziaVPN",
  "keyCard.copyErrToast": "Failed to copy the key",

  // Create-key wizard
  "wizard.proto.awg3.label": "AmneziaWG 3.1",
  "wizard.proto.awg3.desc": "Header protection and trailers (recommended)",
  "wizard.proto.awg2.label": "AmneziaWG 2.0",
  "wizard.proto.awg2.desc": "Compatibility with older clients",
  "wizard.route.full_tunnel.desc": "All traffic goes through the VPN",
  "wizard.route.ru_whitelist.desc": "Foreign resources via VPN, RU direct",
  "wizard.route.ru_blacklist.desc": "Only blocked sites go through the VPN",
  "wizard.recommended": "Recommended",
  "wizard.awg3Hint": "Requires AmneziaVPN {version}+",
  "wizard.rulesNotActive": "Rules not activated yet",
  "wizard.profileDisabled": "Profile selection disabled by the administrator",
  "wizard.createFailed": "Failed to create the key",
  "wizard.title": "New VPN key",
  "wizard.desc": "One key is meant for a single device.",
  "wizard.deviceType": "Device type",
  "wizard.namePlaceholder": "E.g., work laptop",
  "wizard.nameDisplay": "Key name shown in the client",
  "wizard.nameDisplayHint":
    "What the connection title is built from inside the AmneziaVPN app. Set when the key is created and not changed later.",
  "wizard.nameDisplay.server": "Server name",
  "wizard.nameDisplay.label": "Key name",
  "wizard.nameDisplay.number": "Key number",
  "wizard.nameDisplayPreview": "In the client: {value}",
  "wizard.server": "Server",
  "wizard.serverPlaceholder": "Select a server",
  "wizard.serverQuota": "keys {used}/{limit}",
  "wizard.serverQuotaHint":
    "The key limit is counted per server. A server that already reached its limit cannot be selected.",
  "wizard.serverFull": "This server has already reached its key limit.",
  "wizard.protocol": "Protocol",
  "wizard.protocolHint":
    "AmneziaWG 3.1 masks headers and adds random trailers — harder to detect. 2.0 is kept for older clients.",
  "wizard.routing": "Routing",
  "wizard.routingHint":
    "Defines which traffic goes through the VPN. The profile is embedded in the key at creation — later it can only be changed by reissuing.",
  "wizard.routingLocked":
    "The administrator allowed only “All traffic”. Other profiles are unavailable.",
  "wizard.creating": "Creating…",
  "wizard.create": "Create key",

  // Config download dialog
  "config.qrSmall": "small",
  "config.qrMedium": "medium",
  "config.qrLarge": "large",
  "config.keyCopied": "Key copied",
  "config.copyFailed": "Failed to copy",
  "config.title": "Key: {label}",
  "config.desc":
    "Paste the link into AmneziaVPN (“Connect by link”) or scan the QR code with your phone camera.",
  "config.loadFailed": "Failed to load the key.",
  "config.connectionKey": "Connection key (vpn://)",
  "config.done": "Done",
  "config.copy": "Copy",
  "config.qr": "QR code",
  "config.qrSizeAria": "QR code size",
  "config.qrSizeItemAria": "Size: {size}",
  "config.qrAlt": "Connection QR code",
  "config.qrHint": "Point your phone camera at the code",
  "config.qrUnavailableTitle": "QR code is unavailable for this profile",
  "config.qrUnavailableBody":
    "Split-tunnel profiles carry too many routes to fit in a QR code. Use the config above instead — copy the key and paste it into your client (Add → From string/file). Key operation on such profiles is not guaranteed.",

  // Install guide dialog (user page)
  "install.button": "How to connect",
  "install.title": "Install AmneziaVPN and connect",
  "install.desc":
    "Install the app, add your key — and see what to try if the connection does not work.",
  "install.opensNewTab": "Opens in a new tab",
  "install.latestVersion": "Latest version: {version}",
  "install.linksUnavailable":
    "Could not fetch the app download links. Reload the page or try again later.",
  "install.linksStale":
    "Could not check the latest release. The buttons open the releases page — pick the file for your system there.",

  "install.installTitle": "Install the app",
  "install.platform.windows": "Windows",
  "install.platform.macos": "macOS",
  "install.platform.android": "Android",
  "install.platform.ios": "iPhone and iPad",
  "install.pickFile": "Pick the file for your system",
  "install.desktopNote":
    "The Windows and macOS buttons download the installer from the latest release. Run the downloaded file and follow the installer.",
  "install.iosNote":
    "On the App Store the app is called DefaultVPN, not Amnezia. It is the official client from the same developers — install that one.",
  "install.iosProfileWarning":
    "On iPhone and iPad, use a key with no route profile — all traffic goes through the VPN. A key with a profile (“Foreign resources via VPN”, “Only blocked sites”) does connect on iPhone and iPad, but the rules are not applied: all traffic goes direct, outside the VPN, and the app gives no warning. Create keys without a route profile for iPhone and iPad, and use profile keys on Windows, macOS and Android.",
  "install.versionNote":
    "AmneziaWG 3.1 keys only work in client version {version} or newer.",
  "install.apkTitle": "Google Play will not open, or the install fails?",
  "install.apkIntro":
    "Install from the APK — the official AmneziaVPN installer file from the project's releases page.",
  "install.apkStep1": "Tap the button below and wait for the download to finish.",
  "install.apkStep2":
    "Open the downloaded file: from the notification shade, or via Files → Downloads.",
  "install.apkStep3":
    "If Android asks, allow installing from this source (“Allow from this source” for your browser or file manager) and go back.",
  "install.apkStep4": "Tap Install, then Open.",
  "install.apkDownload": "Download the APK",
  "install.apkOtherBuilds":
    "A different device (32-bit, or Android 9-10)? Pick the matching file on the release page.",

  "install.addTitle": "Add the key",
  "install.addStep1":
    "Copy the connection key (vpn://…) from the key card — the Copy button.",
  "install.addStep2": "Open AmneziaVPN and tap + (add a server).",
  "install.addStep3": "Choose Insert (connection key) and paste the copied key.",
  "install.addStep4": "Tap Connect.",
  "install.addResult":
    "The server appears in the app's list under the same name as in the panel, and the app connects to it.",

  "install.confTitle": "The .conf file — easier for split-tunnel profiles",
  "install.confBody":
    "The Download .conf button on the key card gives you a configuration file. It is not pasted as text — it is imported as a file.",
  "install.confSplitBest":
    "For the “Foreign resources via VPN” and “Only blocked sites” profiles this is the better route on Windows, macOS and Android: the connection key there is very long, no QR code is available, and a file is moved and imported in one step. The file keeps the profile's full list of routed subnets.",
  "install.confIosWarning":
    "This does not apply to iPhone and iPad: there a key with a route profile connects but the rules are not applied — neither from the file nor from the connection key. On iPhone and iPad use a key with no route profile.",
  "install.confAmneziaTitle": "In AmneziaVPN",
  "install.confAmneziaStep1": "Download the .conf file from the key card.",
  "install.confAmneziaStep2":
    "Open AmneziaVPN, tap + and choose importing a configuration file.",
  "install.confAmneziaStep3":
    "Pick the downloaded file and tap Connect. On a phone it is easiest to open the file and share it to AmneziaVPN.",
  "install.confOtherTitle": "In another client",
  "install.confOtherBody":
    "The file works in clients that understand AmneziaWG: awg-quick from amneziawg-tools, the AmneziaWG app for Android, routers with the amneziawg package. Import it as an ordinary tunnel.",
  "install.confStockWarning":
    "A stock WireGuard client will not accept this file: it carries AmneziaWG obfuscation parameters (Jc, S1, H1 and others) that WireGuard does not know. Use AmneziaVPN or an AmneziaWG-capable client.",
  "install.confDomainsWarning":
    "The file carries the address ranges, but not the rules written as a site name. In the “Only blocked sites” profile such a site is not routed through the VPN and stays unavailable. In the “Everything except…” profile it goes through the VPN instead of past it. The connection itself works either way — only that one rule is not applied. If it matters, add the connection key in AmneziaVPN instead of the file.",

  "install.fixTitle": "If it does not work",
  "install.fixServer":
    "Try another server: create a key on a different server from the list.",
  "install.fixFullTunnel":
    "Try a key with no route profile (all traffic through the VPN) — that shows whether the problem is the network or the routing rules.",
  "install.fixUpdate":
    "Update AmneziaVPN, and keep doing so regularly: an outdated client is a common reason an AmneziaWG 3.1 key will not connect.",
  "install.checkUpdates": "Latest release page",

  // Quota request dialog
  "quota.sent": "Request sent to the administrator",
  "quota.sendFailed": "Failed to send the request",
  "quota.title": "Additional keys",
  "quota.desc": "Request a higher key limit from the administrator.",
  "quota.additional": "How many more key slots to request",
  "quota.target": "Which server",
  "quota.targetAll": "Every server",
  "quota.currentLimit": "Available now: {limit}",
  "quota.willBecome": "Will become {total} on each server",
  "quota.willBecomeNode": "Will become {total} on \"{node}\"",
  "quota.reason": "Reason",
  "quota.reasonPlaceholder":
    "Explain why you need additional keys (at least 10 characters).",
  "quota.reasonOptional": "Optional, but a short note helps.",
  "quota.sending": "Sending…",
  "quota.submit": "Send request",

  // Traffic
  "traffic.rangeToday": "Today",
  "traffic.range7": "7 days",
  "traffic.range30": "Month",
  "traffic.noData": "No traffic data for this period",
  "traffic.none": "No traffic yet",
  "traffic.total": "Total: ",
  "traffic.received": "Received",
  "traffic.sent": "Sent",

  // Node select
  "nodeSelect.allNodes": "All nodes available",
  "nodeSelect.noNodes": "No available nodes",

  // Protocol select
  "protoSelect.recommended": "recommended",
  "protoSelect.legacy": "legacy",
  "protoSelect.unsupported": "not supported",

  // Admin data (toasts)
  "adminData.actionDone": "Action completed",
  "adminData.actionFailed": "Action failed",

  // Admin overview
  "ov.stateActive": "Active",
  "ov.stateDisabled": "Disabled",
  "ov.stateProvisioning": "Provisioning",
  "ov.stateRevoking": "Revoking",
  "ov.stateRevoked": "Revoked",
  "ov.stateFailed": "Failed",
  "ov.activeKeys": "Active keys",
  "ov.onlineNow": "Online now",
  "ov.totalTraffic": "Total traffic",
  "ov.users": "Users",
  "ov.usersSub": "{active} active · {disabled} disabled",
  "ov.nodesHealthy": "Nodes (healthy)",
  "ov.quotaRequests": "Limit requests",
  "ov.byProtocol": "By protocol",
  "ov.byRouting": "By routing",
  "ov.byStatus": "By status",
  "ov.trafficSummary": "Traffic by period",
  "ov.serversTitle": "Servers",
  "ov.noServers": "No servers added yet",
  "ov.inactiveTitle": "Inactive for more than {days} days",
  "ov.showAll": "Show all",
  "ov.allActiveSeen":
    "All active users have connected within the last {days} days.",
  "ov.quotaReqTitle": "Quota increase requests",
  "ov.colEmployee": "Employee",
  "ov.colTarget": "Server",
  "ov.quotaTargetAll": "Every server",
  "ov.quotaReplacesPerNode":
    "Approving this replaces the user's per-server limits ({count}).",
  "ov.colNewLimit": "New limit",
  "ov.colLimitChange": "Limit: now → requested",
  "ov.colReason": "Reason",
  "ov.colDate": "Date",
  "ov.approve": "Approve",
  "ov.reject": "Reject",
  "ov.noRequests": "No new quota increase requests",

  // Admin users
  "users.deact.admin_offboard": "disabled manually",
  "users.deact.access_removed": "Cloudflare access revoked",
  "upolicy.allowKeyCreation": "Key creation",
  "upolicy.allowNodeSelection": "Node selection",
  "upolicy.allowRouteProfileSelection": "Routing selection",
  "upolicy.allowCustomRoutes": "Custom routes",
  "upolicy.allowConfigRedownload": "Re-download",
  "upolicy.allowQrDownload": "QR codes",
  "upolicy.allowConfDownload": "Download .conf",
  "upolicy.allowSelfRevoke": "Self-revoke",
  "upolicy.showLastUsed": "Last activity",
  "upolicy.showTraffic": "Traffic volume",
  "users.filter.all": "All",
  "users.filter.inactive": "Inactive ({days}d)",
  "users.filter.online": "Online now",
  "users.filter.nokeys": "No keys",
  "users.filter.admins": "Administrators",
  "users.filter.disabled": "Disabled",
  "users.sort.name": "By name",
  "users.sort.activity": "By activity",
  "users.sort.keys": "By key count",
  "users.sort.traffic": "By traffic",
  "users.title": "Users and keys",
  "users.summary": "{users} users · {keys} keys",
  "users.summaryShown": " · showing {shown}",
  "users.searchPlaceholder": "Search by name or e-mail…",
  "users.addBtn": "User",
  "users.noUsers": "No users yet",
  "users.selectLeft": "Select a user on the left",
  "users.added": "User added",
  "users.addFailed": "Failed to add",
  "users.roleAdminLabel": "make an administrator",
  "users.roleRemoveLabel": "remove the role",
  "users.roleConfirm": "Are you sure you want to {label} {email}?",
  "users.offboardConfirm":
    "Disable and delete {email}? All keys will be revoked, and the account is deleted after they are revoked.",
  "users.keysWord": "keys",
  "users.onlineCount": "{count} online",
  "users.limitNode": "Key limit:",
  "users.default": "default",
  "users.policies": "Policies",
  "users.removeAdmin": "Remove admin",
  "users.makeAdmin": "Make admin",
  "users.reinstate": "Restore",
  "users.delete": "Delete",
  "users.statKeys": "Keys",
  "users.statActive": "Active",
  "users.statOnline": "Online",
  "users.statTraffic": "Traffic",
  "users.keys": "Keys",
  "users.keysHint":
    "Managing the user's keys: disable pauses access reversibly, revoke removes the peer permanently.",
  "users.keyBtn": "Key",
  "users.noUserKeys": "This user has no keys yet",
  "users.online": "Online",
  "users.offline": "Offline",
  "users.rulesOutdatedTip": "Rules updated — reissue required",
  "users.disable": "Disable",
  "users.disableConfirm": "Disable “{label}”?",
  "users.enable": "Enable",
  "users.enableConfirm": "Enable “{label}”?",
  "users.exportConfig": "Export configuration",
  "users.revoke": "Revoke",
  "users.revokeConfirm": "Revoke “{label}” permanently?",
  "users.newUser": "New user",
  "users.newUserDesc": "The user signs in with their e-mail via Cloudflare Access.",
  "users.email": "E-mail",
  "users.emailPlaceholder": "ivan@company.com",
  "users.nameOptional": "Name (optional)",
  "users.namePlaceholder": "John Smith",
  "users.role": "Role",
  "users.roleHint": "An administrator sees this panel and manages all keys.",
  "users.limitTitle": "Servers and key limits",
  "users.limitDesc": "{email} — available servers and the key limit on each",
  "users.limitLabel": "Default limit on every server",
  "users.limitLabelHint": "Empty — the global limit ({value}).",
  "users.limitAllNodes": "All servers available",
  "users.limitAllNodesHint":
    "Turn off to pick servers for this user. While on, the global list applies.",
  "users.limitGlobalNodes": "Globally available: {nodes}",
  "users.limitNoneWord": "no servers",
  "users.limitPerNode": "Servers",
  "users.limitPerNodeHint":
    "The checkbox makes a server available to the user. The number is the key limit on that server; empty means the default limit.",
  "users.limitPerNodeAria": "Key limit on server {node}",
  "users.limitColumnLimit": "Limit",
  "users.limitNoNodesWarning":
    "No server selected — the user cannot create a key.",
  "users.policyTitle": "Individual policies",
  "users.policyDesc": "{email} — overrides global settings",
  "users.customProtocols": "Custom protocol set",
  "users.customProtocolsHint": "Otherwise the user sees the global set ({protocols}).",
  "users.nodesMovedHint":
    "Available servers and per-server limits are configured in “Servers and key limits”.",
  "users.savePolicies": "Save policies",
  "users.keyForTitle": "Key for {email}",
  "users.keyForDesc": "Protocol is selected automatically: {protocol}",
  "users.nodeDisabledSuffix": " (disabled)",
  "users.routeHintAdmin":
    "The profile is embedded in the key. “Foreign” and “blocked” require active routing lists.",
  "users.keyCreatedHint":
    "The key is created on the server — the device connects right after importing the configuration.",

  // Admin nodes
  "nodes.cap.peerLifecycle": "Keys",
  "nodes.cap.telemetry": "Telemetry",
  "nodes.cap.backup": "Backup",
  "nodes.enabled": "Node enabled",
  "nodes.disabled": "Node disabled",
  "nodes.changeFailed": "Failed to change",
  "nodes.deleteConfirm": "Delete node “{name}”? This cannot be undone.",
  "nodes.deleted": "Node deleted",
  "nodes.deleteFailed": "Failed to delete the node",
  "nodes.deleteTitle": "Delete node “{name}”",
  "nodes.deleteWithKeys":
    "Deleting the node also permanently deletes every key issued on it. This cannot be undone.",
  "nodes.deleteImpact":
    "{keys} key(s) will be destroyed, revoked ones included. {users} user(s) affected.",
  "nodes.deleteImpactStates": "Of those: {active} active, {other} other.",
  "nodes.deletePeersTitle": "Peers keep working on the server",
  "nodes.deletePeersBody":
    "The panel only removes the keys from its own database — it can no longer reach a node it is deleting. The peer configurations stay in the AmneziaWG containers on the server itself: while that server keeps running, those configurations keep working until it is shut down or wiped by hand.",
  "nodes.deleteTypeName": "Type the node's internal name to confirm",
  "nodes.deleteTypeNameHint": "Exactly: {name}",
  "nodes.deleteAction": "Delete node",
  "nodes.deleteActionKeys": "Delete node and keys",
  "nodes.deleting": "Deleting…",
  "nodes.deletedWithKeys":
    "Node “{name}” deleted. {keys} key(s) removed, {users} user(s) affected.",
  "nodes.titleHint":
    "A node is a server running node-agent where VPN keys are created. The panel manages them via a secure API.",
  "nodes.summary": "{total} servers · {enabled} enabled",
  "nodes.addNode": "Add node",
  "nodes.empty": "No nodes yet",
  "nodes.emptyHint": "Add a server with node-agent to start issuing keys.",
  "nodes.commError": "Connection error",
  "nodes.working": "Running",
  "nodes.stopped": "Disabled",
  "nodes.toggleOff": "Disable node",
  "nodes.toggleOn": "Enable node",
  "nodes.toggleOffTip": "Stop accepting new keys",
  "nodes.toggleOnTip": "Enable node",
  "nodes.protoActive": "Active",
  "nodes.protoSupported": "Supported but disabled",
  "nodes.capacity": "Capacity",
  "nodes.traffic": "Traffic",
  "nodes.healthCheck": "Health check:",
  "nodes.sync": "Sync:",
  "nodes.reconcile": "Reconcile",
  "nodes.edit": "Edit",
  "nodes.deleteAria": "Delete node",
  "nodes.deleteTip": "Delete the node — it has no keys",
  "nodes.deleteTipKeys": "Delete the node together with all its keys ({keys})",
  "nodes.added": "Node added",
  "nodes.addFailed": "Failed to add the node",
  "nodes.createTitle": "Add VPN node",
  "nodes.createDesc": "The API key is stored encrypted and never shown again.",
  "nodes.updated": "Node updated",
  "nodes.updateFailed": "Failed to update the node",
  "nodes.editTitle": "Edit node",
  "nodes.editDesc": "Leave the API key empty to keep the current one.",
  "nodes.enabledToggle": "Node enabled",
  "nodes.internalName": "Internal name",
  "nodes.internalNameHint": "Visible to admins only",
  "nodes.publicName": "Name for users",
  "nodes.publicNameHint":
    "How users see this server. Empty falls back to the internal name.",
  "nodes.publicNamePlaceholder": "e.g. Netherlands",
  "nodes.seenAs": "Users see: {name}",
  "nodes.agentAddr": "Node-agent address",
  "nodes.agentHint":
    "URL of the amnezia-api agent on the server: a direct https://SERVER:PORT or http://host.docker.internal:4001 over an SSH tunnel",
  "nodes.apiKeyRequired": "API key (at least 32 characters)",
  "nodes.apiKeyNew": "New API key",
  "nodes.apiKeyNewHint": "Leave empty to keep the current key",
  "nodes.protocols": "Node protocols",
  "nodes.protocolsHint": "Which protocols the node offers to users",
  "nodes.peerLimit": "Peer limit",

  // Admin policy
  "gpolicy.allowKeyCreation": "Key creation",
  "gpolicy.allowNodeSelection": "VPN node selection",
  "gpolicy.allowRouteProfileSelection": "Routing profile selection",
  "gpolicy.allowCustomRoutes": "User custom routes",
  "gpolicy.allowConfigRedownload": "Configuration re-download",
  "gpolicy.allowQrDownload": "QR code display",
  "gpolicy.allowConfDownload": ".conf file download",
  "gpolicy.allowSelfRevoke": "Self-revocation of keys",
  "gpolicy.showPublicKey": "Show public key",
  "gpolicy.showLastUsed": "Show last activity date",
  "gpolicy.showTraffic": "Show traffic volume",
  "gpolicy.allowKeyCreationHint":
    "The user can create new keys for their own devices.",
  "gpolicy.allowNodeSelectionHint":
    "The user can choose which server (node) a key is created on.",
  "gpolicy.allowRouteProfileSelectionHint":
    "The user can choose a routing profile: all traffic, foreign-only, or blocked-sites-only.",
  "gpolicy.allowCustomRoutesHint":
    "The user can add their own domains and IPs to their profile's whitelist/blacklist.",
  "gpolicy.allowConfigRedownloadHint":
    "The user can re-download the config of an already-created key.",
  "gpolicy.allowQrDownloadHint":
    "The user can get a QR code for quick connection.",
  "gpolicy.allowConfDownloadHint": "The user can download a key's .conf file.",
  "gpolicy.allowSelfRevokeHint":
    "The user can revoke (delete) their own keys.",
  "gpolicy.showPublicKeyHint":
    "Show the device's public key on the key card.",
  "gpolicy.showLastUsedHint": "Show when the key was last used.",
  "gpolicy.showTrafficHint":
    "Show traffic volume (received/sent) per key.",
  "policy.title": "Global portal policy",
  "policy.keyLimit": "Key limit per node",
  "policy.keyLimitHint":
    "How many keys a user gets per node by default. Individual users can have this overridden.",
  "policy.retention": "History retention (days)",
  "policy.retentionHint":
    "How many days of daily traffic history to keep; older rows are pruned.",
  "policy.cfAccountIdHint":
    "Cloudflare account ID (Zero Trust → Settings → General).",
  "policy.cfAppIdHint": "ID of the Access application that guards the panel login.",
  "policy.cfPolicyIdHint":
    "ID of the allow policy whose email list is synced with the panel's active users.",
  "policy.cfTokenHint":
    "Cloudflare API token with Access: Apps and Policies — Edit. Stored encrypted; only a placeholder is shown, and entering a value replaces it.",
  "policy.defaultProtocols": "Default protocols",
  "policy.defaultProtocolsHint":
    "Which protocols are offered to everyone when creating a key. Only AWG 3.1 is used now; AWG 2.0 can be re-enabled here, on a specific node, or for an individual user.",
  "policy.availableNodes": "Available nodes",
  "policy.availableNodesHint":
    "Which nodes users can create keys on. Individual users can be assigned their own set in their policies.",
  "policy.employeePerms": "Employee permissions",
  "policy.telemetryDisplay": "Telemetry display",
  "policy.cfAccessHint":
    "For two-way user synchronization with Access. The API token is stored encrypted and never shown — it can only be replaced. See docs/CLOUDFLARE-ACCESS.md.",
  "policy.cfToken": "API token (Access: Apps and Policies — Edit)",
  "policy.cfTokenSet": "•••••••••• — set, enter a new one to replace",
  "policy.cfTokenPlaceholder": "Paste the token",
  "policy.saveGlobal": "Save global policies",
  "common.saving": "Saving…",

  // Admin audit
  "audit.subtitle": "Action history · {count} records",
  "audit.searchPlaceholder": "Search events…",
  "audit.empty": "The log is empty",
  "audit.system": "System",
  "audit.verb.create": "added",
  "audit.verb.create-key": "created a key",
  "audit.verb.disable": "disabled",
  "audit.verb.enable": "enabled",
  "audit.verb.revoke": "revoked",
  "audit.verb.offboard": "disabled a user",
  "audit.verb.reinstate": "restored a user",
  "audit.verb.set-limit": "changed the limit",
  "audit.verb.set-policy": "changed policies",
  "audit.verb.set-role": "changed the role",
  "audit.verb.reconcile": "synchronized",
  "audit.verb.update": "updated",
  "audit.verb.activate": "activated",
  "audit.verb.seed": "loaded lists",
  "audit.verb.approve": "approved a request",
  "audit.verb.reject": "rejected a request",
  "audit.res.users": "user",
  "audit.res.keys": "key",
  "audit.res.nodes": "node",
  "audit.res.quota-requests": "limit request",
  "audit.res.portal-policy": "global policies",
  "audit.res.rules": "routing rules",
  "audit.exact.vpn_key.create_requested": "requested key creation",
  "audit.exact.vpn_key.revoke_requested": "requested key revocation",
  "audit.exact.vpn_key.rotate_requested": "requested key reissue",
  "audit.exact.vpn_key.private_config_viewed": "viewed a private config",
  "audit.exact.node.created": "added a node",
  "audit.exact.node.updated": "updated a node",
  "audit.exact.node.deleted": "deleted a node",
  "audit.exact.node.reconcile": "synchronized a node",
  "audit.exact.quota_request.created": "created a limit request",
  "audit.exact.user.access_revoked": "deactivated — Cloudflare access revoked",
  "audit.exact.user.deleted": "deleted (after keys revoked)",
  "audit.exact.admin.users.create": "added a user",
  "audit.exact.admin.users.create-key": "created a key for a user",
  "audit.exact.admin.portal-policy.update": "updated global policies",
  "audit.exact.admin.rules.activate": "activated routing rules",
  "audit.exact.admin.nodes.reconcile": "synchronized a node",
  "audit.target.vpn_key": "key",
  "audit.target.user": "user",
  "audit.target.node": "node",
  "audit.target.portal_policy": "policies",
  "audit.target.route_rule": "rules",
  "audit.target.rule_version": "rules",
  "audit.target.quota_request": "request",

  // Admin rules
  "rules.status.active": "Active",
  "rules.status.superseded": "Superseded",
  "rules.status.quarantined": "Quarantined",
  "rules.title": "Routing rules (RoscomVPN)",
  "rules.autoUpdate":
    "Lists refresh automatically every 6 hours from the configured sources (RULE_FEEDS).",
  "rules.colProfile": "Profile",
  "rules.colVersion": "Version",
  "rules.colSubnets": "Subnets / Domains",
  "rules.colStatus": "Status",
  "rules.colPublished": "Published",
  "rules.cidrDomains": "CIDR: {cidr} · Domains: {domains}",
  "rules.notActive": "Not active",
  "rules.viewAria": "View rules",
  "rules.viewTitle": "View and compare",
  "rules.activate": "Activate",
  "rules.empty": "No rule versions loaded yet.",
  "rules.refresh": "Check for updates",
  "rules.refreshQueued": "Queued…",
  "rules.refreshRunning": "Checking…",
  "rules.refreshUnchanged": "Checked, nothing new",
  "rules.refreshUpdated": "A new list version was loaded",
  "rules.refreshFailed": "The update check failed",
  "rules.refreshFailedWith": "The update check failed: {error}",
  "rules.refreshTimeout":
    "The check is taking longer than usual — reload the page a bit later",

  // Admin global routes
  "groutes.title": "Global routes",
  "groutes.subtitle":
    "Shared additions and exclusions on top of the RoscomVPN lists — applied to every user.",
  "groutes.hint":
    "Entries take effect on the next config export. Exclusions are removed first, then the global additions are merged in, and the user's own routes are applied last.",
  "groutes.count": "{count} total",
  "groutes.expand": "Open",
  "groutes.collapse": "Collapse",
  "groutes.unsaved": "Unsaved changes",
  "groutes.add": "Add routes",
  "groutes.addHint":
    "Extra subnets and domains merged into the selected profile's list for every user.",
  "groutes.exclude": "Exclude from the RoscomVPN lists",
  "groutes.excludeHint":
    "Subnets and domains stripped from the list before it is handed out. Excluding a domain also removes its subdomains. If a user adds the same entry to their own routes it comes back — personal routes win.",
  "groutes.save": "Save routes",

  // Rule preview dialog
  "rpd.loadFailed": "Failed to load",
  "rpd.compareFailed": "Failed to compare versions",
  "rpd.title": "Rules: {profile}",
  "rpd.version": "Version",
  "rpd.cidrBadge": "CIDR: {count}",
  "rpd.domainsBadge": "Domains: {count}",
  "rpd.compareActive": "Compare with the active version",
  "rpd.showDiff": "Show differences",
  "rpd.cidrTitle": "CIDR",
  "rpd.domains": "Domains",
  "rpd.subnetsCidr": "Subnets (CIDR)",

  // Admin config export dialog
  "acfg.title": "Export configuration",
  "acfg.warning":
    "Viewing other people's configs is recorded in the audit log with your identifier.",
  "acfg.confirmLabel": "I confirm the operational need for this export",
  "acfg.fetchFailed": "Failed to fetch the configuration",
  "acfg.copied": "Copied",
} satisfies Record<keyof typeof ru, string>;

export const messages = { ru, en } as const;

export type Lang = keyof typeof messages;
export type MessageKey = keyof typeof ru;
