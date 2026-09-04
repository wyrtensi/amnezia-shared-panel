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
  "device.ios": "iPhone iPad (iOS)",
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
  "emp.nodeAddress": "Адрес сервера",
  "emp.quotaTotal": "До {limit} на всех серверах вместе",
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
  // In global mode the per-server row has no limit of its own to announce.
  "quota.cellsIssuedAria": "{used} ключей на этом сервере",
  "quota.noKeysOnServer": "нет ключей",
  "quota.cellIssued": "Ключ выпущен",
  "quota.cellFree": "Свободный слот",

  // Key card
  "keyCard.rulesUpdatedTitle": "Правила маршрутизации обновились",
  "keyCard.updateKey": "Обновить ключ",
  "keyCard.rulesUpdatedBody":
    "Перевыпустите ключ, чтобы применить новые правила. Старый конфиг перестанет работать — переустановите ключ на устройстве.",
  "keyCard.iphoneProfileWarning":
    "Этот ключ создан для iPhone или iPad и содержит профиль маршрутизации, а на iPhone и iPad профили маршрутизации недоступны. Создайте для этого устройства ключ «Весь трафик». На Windows, macOS, Linux и Android этот ключ работает как обычно.",
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
  "wizard.route.ru_blacklist.desc":
    "Через VPN идут лишь сайты из списка. Нужного вам сайта в нём может не оказаться — тогда он не откроется.",
  "wizard.recommended": "Рекомендуется",
  "wizard.awg3Hint": "Требуется AmneziaVPN {version}+",
  "wizard.rulesNotActive": "Правила ещё не активированы",
  "wizard.profileDisabled": "Выбор профиля отключён администратором",
  "wizard.profileNoIphone": "Недоступно на iPhone и iPad",
  "wizard.hasAmneziaClient": "У меня AmneziaVPN, а не Default VPN",
  "wizard.hasAmneziaClientHint":
    "Отметьте, только если вы действительно поставили AmneziaVPN (в российском App Store его нет). Профили маршрутизации станут доступны, но их работа на iOS не проверена.",
  "wizard.routingNoIphone":
    "На iPhone и iPad профили маршрутизации недоступны — доступен только «Весь трафик».",
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
  // Global mode has no per-server denominator to show, only the count.
  "wizard.serverKeys": "ключей {used}",
  "wizard.serverQuotaHint":
    "Лимит ключей считается по каждому серверу отдельно. Сервер, где лимит уже выбран, выбрать нельзя.",
  "wizard.serverQuotaHintGlobal":
    "Лимит общий на все серверы: занято {used} из {limit}.",
  "wizard.serverFull": "На этом сервере лимит ключей уже исчерпан.",
  "wizard.poolFull": "Общий лимит ключей исчерпан.",
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

  // "How do I make a key?" dialog — the form only. Anything about installing
  // the client or connecting belongs to install.* instead.
  "keyHelp.button": "Не понятно как создать ключ →",
  "keyHelp.title": "Как создать ключ",
  "keyHelp.desc": "Что значит каждое поле в форме создания ключа.",
  "keyHelp.deviceBody":
    "Выберите устройство, на котором будете подключаться. Один ключ — одно устройство; для второго создайте ещё один.",
  "keyHelp.nameBody":
    "Как вы сами будете отличать этот ключ от других. Можно оставить как есть.",
  "keyHelp.namesBody":
    "Это то, как ключ будет отображаться у вас в приложении, чтобы не запутаться. Строка «в клиенте» показывает предпросмотр.",
  "keyHelp.serverBody":
    "Лучше всегда выбирать рекомендуемый. Обычно доступно несколько локаций, можете выбрать любую.",
  "keyHelp.alwaysWorks": "работает всегда",
  "keyHelp.noGuarantee": "без гарантий",
  "keyHelp.routingBody":
    "Самый надёжный вариант. Если у вас что-то не работает — выбирайте его.",
  "keyHelp.profilesIntro":
    "Про остальные два профиля читайте внимательно. Их работа не гарантируется, они сделаны для удобства:",
  "keyHelp.whitelistBody":
    "Мы постараемся, чтобы для российских сервисов выглядело, что вы сидите из дома. Лучше, чем «Только заблокированные», но менее надёжно для стабильной работы VPN в целом.",
  "keyHelp.blacklistBody":
    "Профиль со списком определённых сайтов. Список большой, но в нём могут быть не все нужные вам заблокированные ресурсы, и они не откроются через VPN.",
  "keyHelp.troubleTitle": "Если есть проблемы в работе",
  "keyHelp.troubleBody":
    "Смените сервер или переключите маршрутизацию на «Весь трафик». Если у вас мобильный интернет, переход на Wi-Fi часто решает проблемы с доступом.",

  // Config download dialog
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
  "config.qrAlt": "QR-код для подключения",
  "config.qrHint": "Наведите камеру телефона на код — откроется AmneziaVPN",
  "config.qrZoom": "Размер QR-кода",
  "config.qrZoomHint":
    "Не сканируется? Разверните код на весь экран — и на мониторе, и на экране ноутбука это помогает больше всего.",
  "config.qrMaximize": "Развернуть код на весь экран",
  "config.qrFullscreen": "QR-код на весь экран",
  "config.qrAudienceLabel": "Чем будете сканировать?",
  "config.qrForCamera": "Камера телефона",
  "config.qrForApp": "Приложение VPN",
  "config.qrHintApp":
    "В приложении (AmneziaVPN или Default VPN) нажмите «Добавить» → «Сканировать QR-код» и наведите камеру на этот код",
  "config.qrAppWarning":
    "Этот код понимает только само приложение. Обычная камера его не откроет.",
  "config.qrSwitchToApp":
    "Сканируете из самого приложения (AmneziaVPN или Default VPN)? Откройте код для приложения",
  "config.qrSwitchToCamera":
    "Сканируете обычной камерой телефона? Вернитесь к коду для камеры",
  "config.qrFrameModeAria": "Режим показа кадров",
  "config.qrFrameModeAnimated": "Анимация",
  "config.qrFrameModeStatic": "Статика",
  "config.qrFramesLoop":
    "Кадры сменяются сами и повторяются по кругу — держите камеру на коде, пока приложение не соберёт все кадры",
  "config.qrFramesManual":
    "Кадр стоит на месте — переключайте кадры стрелками, пока приложение не соберёт все",
  "config.qrFrameCounter": "Кадр {current} из {total}",
  "config.qrFramePrev": "Предыдущий кадр",
  "config.qrFrameNext": "Следующий кадр",
  "config.qrFramesFailed": "Не удалось загрузить код для приложения",
  "config.qrFramesRetry": "Попробовать снова",
  "config.qrUnavailableTitle": "QR-код недоступен для этого профиля",
  "config.qrUnavailableWhy":
    "Дело не в размере кода: в этом профиле тысячи маршрутов, ключ занимает от 60 тысяч символов, а в QR-код помещается около 2900. Такой ключ не влезает ни в один код — ни в большой, ни в серию кадров.",
  "config.qrUnavailableBody":
    "Скопируйте ключ кнопкой выше и вставьте его в вашем клиенте (Добавить → Из строки/файла) — или скачайте конфиг-файл. Работа ключа на таких профилях не гарантируется.",

  // Install guide dialog (user page)
  "install.button": "Как подключиться",
  "install.title": "Установка AmneziaVPN и подключение",
  "install.desc":
    "Три шага: поставить приложение, добавить ключ, что делать, если не работает.",
  "install.opensNewTab": "Откроется в новой вкладке",
  "install.latestVersion": "Последняя версия: {version}",
  "install.linksUnavailable":
    "Не удалось получить ссылки. Обновите страницу или попробуйте позже.",
  "install.linksStale":
    "Не удалось проверить выпуск. Кнопки ведут на страницу выпусков.",

  "install.installTitle": "Установите приложение",
  "install.platform.windows": "Windows",
  "install.platform.macos": "macOS",
  "install.platform.linux": "Linux",
  "install.platform.android": "Android",
  "install.platform.ios": "iPhone и iPad",
  "install.chooseTitle": "Выберите устройство",
  "install.showQr": "Показать QR",
  "install.qrAlt": "QR-код со ссылкой на приложение",
  "install.qrHint":
    "Наведите камеру телефона — откроется страница приложения.",
  "install.videoTitle": "Видео с разбором",
  "install.videoSoon": "Видео появится здесь позже.",
  "install.chooseHint": "Выберите устройство выше.",
  "install.group.desktop": "Windows, macOS, Linux",
  "install.group.android": "Android",
  "install.group.ios": "iPhone и iPad (iOS)",
  "install.pickFile": "Выберите файл для своей системы",
  "install.iosAmneziaTitle": "Если ваш аккаунт Apple не российский",
  "install.iosAmneziaBody":
    "Тогда можно поставить сам AmneziaVPN — он умеет больше. Из российского App Store он скрыт.",
  "install.iosAmneziaOpen": "Открыть AmneziaVPN в App Store",
  "install.desktopNote":
    "Запустите скачанный файл и следуйте установщику.",
  "install.iosNote":
    "В российском App Store приложение называется Default VPN — ставьте его.",
  // Says only what is known. What a client does with a profile key on iOS has
  // not been checked on a device, and a claim a user acts on has to be one we
  // can stand behind.
  "install.iosProfileWarning":
    "На iPhone и iPad профили маршрутизации недоступны — создавайте ключ «Весь трафик».",
  "install.versionNote":
    "Ключи AmneziaWG 3.1 работают в клиенте {version} или новее.",
  "install.apkTitle": "Google Play не открывается?",
  "install.apkIntro":
    "Поставьте официальный APK AmneziaVPN со страницы выпусков.",
  "install.apkStep1": "Нажмите кнопку ниже и дождитесь загрузки.",
  "install.apkStep2":
    "Откройте скачанный файл: шторка загрузок или «Файлы» → «Загрузки».",
  "install.apkStep3":
    "Разрешите установку из источника, если Android попросит, и нажмите «Установить».",
  "install.apkDownload": "Скачать APK",
  "install.apkOtherBuilds":
    "32-битное устройство или Android 9-10? Выберите файл на странице выпуска.",

  "install.addTitle": "Добавьте ключ",
  "install.addStep1": "На карточке ключа нажмите «Копировать».",
  "install.addStep2": "В приложении: «+» → «Вставить», вставьте ключ.",
  "install.addStep3": "Нажмите «Подключиться».",

  "install.confTitle": "Второй способ: файл .conf",
  "install.confBody":
    "Кнопка «Скачать .conf» сохраняет ключ файлом. Его открывают в приложении.",
  "install.confSplitBest":
    "Удобно для профилей «Только зарубежные» и «Только заблокированные»: такой ключ очень длинный, а файл достаточно открыть один раз.",
  "install.confIosWarning":
    "На iPhone и iPad не поможет: правила не применятся. Там нужен ключ «Весь трафик».",
  "install.confHow":
    "В AmneziaVPN: «+» → импорт файла конфигурации. Обычный WireGuard этот файл не откроет.",
  "install.confDomainsWarning":
    "Правило по имени сайта в файл не попадёт — там только числовые адреса. Чтобы оно сохранилось, добавляйте ключ копированием.",

  "install.fixTitle": "Если не работает",
  "install.fixServer": "Создайте ключ на другом сервере.",
  "install.fixFullTunnel":
    "Попробуйте ключ «Весь трафик» — так видно, дело в сети или в правилах.",
  "install.fixAmneziaDns":
    "В настройках AmneziaVPN выключите «Использовать DNS-серверы Amnezia»: с ней подключение есть, а сайты не открываются.",
  "install.fixUpdate":
    "Обновите AmneziaVPN: устаревший клиент — частая причина отказа.",
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
  "quota.willBecomeTotal": "Станет {total} на все серверы вместе",
  "quota.reason": "Обоснование",
  "quota.reasonPlaceholder":
    "Например: рабочий ноутбук и телефон, ключей на всех не хватает.",
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
  // S4: a request raised before the switch to a shared pool still names a
  // server; the admin must see that approving it now raises the total instead.
  "ov.quotaTargetCoerced":
    "Запрос был создан для сервера «{node}». Сейчас лимит общий — одобрение поднимет общий лимит.",
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
  "upolicy.showNodeAddress": "Адрес сервера",
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
  // S7: the button now covers both the number and the server list.
  "users.limitNode": "Лимиты и серверы:",
  "users.limitModeGlobalShort": "общий",
  "users.limitModePerNodeShort": "на сервер",
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
  "users.purge":
    "Удалить из панели",
  "users.purgeConfirm":
    "Удалить ключ «{{label}}» из панели совсем? На ноде его уже нет. Исчезнет сама запись и вся её статистика — останется только запись в журнале аудита. Отменить нельзя.",
  "users.revokeConfirm": "Отозвать «{label}» безвозвратно?",
  "users.internalName": "Служебное имя",
  "users.internalNamePrompt":
    "Служебное имя ключа. Видно только администраторам, пользователю не показывается и в конфигурацию не попадает. Пустое значение — очистить.",
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
  "users.limitMode": "Режим лимита",
  "users.limitModeHint":
    "Как считать лимит для этого пользователя: на каждом сервере отдельно или одним числом на все серверы. Пусто — как в глобальной политике.",
  "users.limitModeInherit": "Как в глобальной политике ({mode})",
  "users.limitModePerNode": "На каждом сервере",
  "users.limitModeGlobal": "Общий на все серверы",
  "users.limitLabel": "Лимит по умолчанию на каждом сервере",
  "users.limitLabelHint": "Пусто — глобальный лимит ({value}).",
  "users.limitLabelGlobal": "Общий лимит ключей",
  "users.limitLabelGlobalHint":
    "Пусто — глобальный лимит ({value}). Считается суммарно по всем серверам.",
  // S3: per-server numbers stay in the DB while the pool is in charge.
  "users.limitPerNodeDormant":
    "Пока лимит общий, лимиты по серверам не действуют. Они сохраняются и вернутся при переключении обратно.",
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
  // Host metrics on the admin node card, and the three words a USER is shown
  // for one service check. The prefix is deliberate: `checks.state.*`, not
  // `nodes.state.*` - these words describe a check, and a key under `nodes.`
  // would invite the next person to reuse them for a node.
    "checks.resetHint":
    "Сбросить сохранённые результаты этой проверки. Ничего не теряется: результат и есть расписание, поэтому все ноды измерят её заново на ближайшем опросе.",
  "checks.resetDone":
    "Результаты сброшены — ноды измерят проверку заново на ближайшем опросе.",
  "nodes.checks.all": "Все проверки",
 "checks.scope":
    "Каждая проверка выполняется на всех нодах — ниже под ней видно, что ответила каждая. Отдельной проверки «для одной ноды» нет.",
  "nodes.checks.title": "Сервисы с этой ноды",
  "nodes.checks.none":
    "Эта нода ещё не отвечала по проверкам. Обычная причина — агент старее 1.1.5, он такого запроса не понимает.",
 "checks.title": "Проверки сервисов",
  "checks.cliHint":
    "Набор правил открытый, поэтому проверки создаются и правятся из CLI: check-create, check-set. Здесь — включить, запустить и посмотреть, что отвечают ноды.",
  "checks.empty": "Проверок пока нет.",
  "checks.every": "раз в {minutes} мин",
  "checks.run": "Запустить",
  "checks.runQueued":
    "Проверка помечена как готовая к запуску: ноды выполнят её на ближайшем опросе.",
  "checks.noResults": "Результатов ещё нет.",
  "checks.deleteConfirm":
    "Удалить проверку «{name}» и все её результаты по нодам?",
  "checks.loadFailed": "Не удалось загрузить проверки",
  "checks.actionFailed": "Не удалось выполнить действие",
  "checks.state.works": "работает",
  "checks.state.unavailable": "недоступен",
  "checks.state.unknown": "неизвестно",
  "nodes.metrics.title": "Метрики хоста",
  "nodes.metrics.never": "Нода ещё не отвечала — метрик нет.",
  "nodes.metrics.ram": "Память",
  "nodes.metrics.swap": "Swap",
  "nodes.metrics.disk": "Диск",
  "nodes.metrics.free": "свободно",
  "nodes.metrics.load": "Нагрузка / ядра",
  "nodes.metrics.pids": "Задачи агента",
  "nodes.metrics.awg3": "AWG 3.1",
  "nodes.metrics.awg2": "AWG 2.0",
  "nodes.metrics.up": "поднят",
  "nodes.metrics.down": "не поднят",
  "nodes.metrics.agentLatency": "Ответ агента",
  "nodes.metrics.lastHandshake": "Последний handshake",
  "nodes.metrics.handshakeAgo": "{minutes} мин назад",
  "nodes.metrics.handshakeNever": "не было",
  "gpolicy.showNodeStatus": "Показывать состояние сервисов",
  "gpolicy.showNodeStatusHint":
    "Рядом с сервером пользователь видит название сервиса и одно из трёх слов: работает, недоступен, неизвестно. Ни адреса, ни подробностей.",
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
      "nodes.capacityChange": "Ёмкость",
    "nodes.capacityTip": "Сколько пиров принимает сама нода. Меняется на ноде, не только в панели.",
    "nodes.capacityTitle": "Ёмкость узла {{name}}",
    "nodes.capacityBody": "Нода перепишет свой .env и пересоздаст только агент. Туннели не рвутся, пиры не теряются.",
    "nodes.capacityPeers": "Пиров",
    "nodes.capacityRange": "От 1 до 500. Выше 500 — непроверенная конфигурация, её задают на ноде вручную.",
    "nodes.capacityNoDowntime": "Пересоздаётся только node-agent. AWG-контейнеры не трогаются, поэтому существующие подключения продолжают работать. Если агент не станет здоровым, нода сама вернёт прежнее значение.",
    "nodes.capacityLastFailure": "Прошлая попытка не удалась: {{message}}",
    "nodes.capacityConfirm": "Применить",
    "nodes.capacityBusy": "Отправляем…",
    "nodes.capacityQueued": "Изменение ёмкости для {{name}} запрошено",
    "nodes.capacityFailed": "Не удалось запросить изменение ёмкости",
"nodes.capacity": "Ёмкость",
  "nodes.traffic": "Трафик",
  "nodes.healthCheck": "Проверка:",
  "nodes.sync": "Синхрон.:",
  "nodes.reconcile": "Сверка",
  "nodes.agentUpdate": "Обновить агент",
  "nodes.agentUpdateTip": "Установить агент {version}. Туннели не разрываются: пересоздаётся только контейнер агента",
  "nodes.agentUpdateUnresolved": "Панель пока не получила опубликованный образ агента",
  "nodes.agentUpdateTitle": "Обновить агент на «{name}»",
  "nodes.agentUpdateBody": "Нода скачает указанный образ и пересоздаст только контейнер агента. Устанавливается ровно тот digest, который показан здесь.",
  "nodes.agentUpdateRunning": "Сейчас",
  "nodes.agentUpdateInstall": "Установить",
  "nodes.agentUpdateVersion": "Версия",
  "nodes.agentUpdateUnknown": "неизвестно",
  "nodes.agentUpdateNoDowntime": "Контейнеры AWG не трогаются, поэтому ни одно подключение не прервётся. Если новый агент не пройдёт health-check, нода откатится на прежний digest.",
  "nodes.agentUpdateConfirm": "Обновить",
  "nodes.agentUpdateBusy": "Отправляем…",
  "nodes.agentUpdateQueued": "Обновление агента на «{name}» запрошено",
  "nodes.agentUpdateFailed": "Не удалось запросить обновление",
  "nodes.agentUpdateLog": "Журнал обновления",
  "nodes.agentUpdate.requested": "Обновление агента запрошено",
  "nodes.agentUpdate.running": "Агент обновляется",
  "nodes.agentUpdate.succeeded": "Агент обновлён",
  "nodes.agentUpdate.failed": "Обновление агента не удалось",
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
  "nodes.publicAddress": "Публичный адрес",
  "nodes.publicAddressHint":
    "Адрес, к которому подключаются клиенты (SERVER_PUBLIC_HOST ноды). IP панель определяет сама; если определить не удалось, показывается последний известный.",
  "nodes.publicAddressUnknown": "Нода ещё не сообщила адрес",
  "nodes.publicAddressUnknownHint":
    "Node-agent на этой ноде не отдаёт publicHost — обновите его образ.",
  "nodes.publicIpResolvedAt": "IP определён {when}",
  "nodes.publicIpUnresolved": "IP не определён",
  "nodes.publicIpUnresolvedHint":
    "Панель не смогла разрешить это имя в IP при последнем опросе.",
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
  "gpolicy.showNodeAddress": "Показывать адрес сервера",
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
  "gpolicy.showNodeAddressHint":
    "Пользователь видит адрес каждого доступного ему сервера (IP или домен) в списке серверов. По умолчанию выключено: адрес уже есть в его конфиге, но показывать его в панели — решение администратора.",
  "gpolicy.keyLimitMode": "Общий лимит на все серверы",
  "gpolicy.keyLimitModeHint":
    "Включено — лимит считается суммарно по всем серверам. Выключено — отдельно на каждом сервере. Лимиты по серверам при этом сохраняются, но не действуют. Отдельному пользователю режим можно задать в «Лимиты и серверы».",
  "policy.title": "Глобальная политика портала",
  "policy.keyLimit": "Лимит ключей на ноду",
  "policy.keyLimitHint":
    "Сколько ключей по умолчанию доступно пользователю на каждой ноде. Для отдельного человека лимит можно переопределить.",
  // The same number, relabelled: in global mode it is a pool, not a per-node cap.
  "policy.keyLimitGlobal": "Общий лимит ключей",
  "policy.keyLimitGlobalHint":
    "Сколько ключей суммарно на всех серверах доступно пользователю по умолчанию. Для отдельного человека лимит можно переопределить.",
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
  "policy.nodeOrder": "Порядок серверов",
  "policy.nodeOrderHint":
    "Порядок, в котором пользователи видят серверы — на панели и при создании ключа. Рекомендуемые серверы всегда стоят наверху списка: отметьте нужный, и он сам поднимется в этот блок, остальные строки останутся как были. Снимете отметку — сервер опустится сразу под блоком рекомендуемых. Отметка не расширяет доступ: недоступный пользователю сервер он не увидит, даже если тот рекомендован.",
  "policy.recommendToggle": "Рекомендовать (поднимет сервер наверх)",
  "policy.recommendedSummary": "Рекомендуется первых: {count} из {total}",
  "policy.moveUp": "Выше",
  "policy.moveDown": "Ниже",
  "policy.dragHint":
    "Строки можно перетаскивать мышью; стрелками — с клавиатуры и на телефоне.",
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
  "audit.exact.admin.nodes.agent-update": "запросил обновление агента ноды",
  "audit.exact.node.agent-update.requested": "передал ноде запрос на обновление агента",
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
  "device.ios": "iPhone iPad (iOS)",
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
  "emp.nodeAddress": "Server address",
  "emp.quotaTotal": "Up to {limit} across all servers",
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
  "quota.cellsIssuedAria": "{used} keys on this server",
  "quota.noKeysOnServer": "no keys",
  "quota.cellIssued": "Key issued",
  "quota.cellFree": "Free slot",

  // Key card
  "keyCard.rulesUpdatedTitle": "Routing rules have changed",
  "keyCard.updateKey": "Update key",
  "keyCard.rulesUpdatedBody":
    "Reissue the key to apply the new rules. The old config will stop working — reinstall the key on the device.",
  "keyCard.iphoneProfileWarning":
    "This key was created for an iPhone or iPad and carries a route profile, and route profiles are not available on iPhone and iPad. Create an “All traffic” key for that device. On Windows, macOS, Linux and Android this key works normally.",
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
  "wizard.route.ru_blacklist.desc":
    "Only sites on the list go through the VPN. The site you need may not be on it — and then it will not open.",
  "wizard.recommended": "Recommended",
  "wizard.awg3Hint": "Requires AmneziaVPN {version}+",
  "wizard.rulesNotActive": "Rules not activated yet",
  "wizard.profileDisabled": "Profile selection disabled by the administrator",
  "wizard.profileNoIphone": "Not available on iPhone and iPad",
  "wizard.hasAmneziaClient": "I have AmneziaVPN, not Default VPN",
  "wizard.hasAmneziaClientHint":
    "Tick this only if you really installed AmneziaVPN (it is not in the Russian App Store). Route profiles become selectable, though how they behave on iOS has not been verified.",
  "wizard.routingNoIphone":
    "Route profiles are not available on iPhone and iPad — only “All traffic” is offered.",
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
  "wizard.serverKeys": "keys {used}",
  "wizard.serverQuotaHint":
    "The key limit is counted per server. A server that already reached its limit cannot be selected.",
  "wizard.serverQuotaHintGlobal":
    "The limit is shared by every server: {used} of {limit} used.",
  "wizard.serverFull": "This server has already reached its key limit.",
  "wizard.poolFull": "The shared key limit is used up.",
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

  // "How do I make a key?" dialog — the form only. Anything about installing
  // the client or connecting belongs to install.* instead.
  "keyHelp.button": "Not sure how to create a key →",
  "keyHelp.title": "How to create a key",
  "keyHelp.desc": "What each field of the create-key form means.",
  "keyHelp.deviceBody":
    "Pick the device you will connect from. One key is for one device — make another for the second.",
  "keyHelp.nameBody":
    "How you will tell this key from your others. You can leave it as it is.",
  "keyHelp.namesBody":
    "This is how the key will show up in your app, so you do not mix them up. The “in the client” line is a live preview.",
  "keyHelp.serverBody":
    "Always take the recommended one. There are usually several locations available — any of them will do.",
  "keyHelp.alwaysWorks": "always works",
  "keyHelp.noGuarantee": "no guarantee",
  "keyHelp.routingBody":
    "The dependable one. If something is not working for you, pick this.",
  "keyHelp.profilesIntro":
    "Read the other two profiles carefully. They are not guaranteed to work; they exist for convenience:",
  "keyHelp.whitelistBody":
    "We do our best to make Russian services see you as if you were at home. Better than “Blocked only”, but less dependable for the VPN working steadily overall.",
  "keyHelp.blacklistBody":
    "A profile with a list of certain sites. The list is large, but it may not hold every blocked resource you need, and those will not open through the VPN.",
  "keyHelp.troubleTitle": "If something is not working",
  "keyHelp.troubleBody":
    "Change the server, or switch the routing to “All traffic”. If you are on mobile data, moving to Wi-Fi often fixes access problems.",

  // Config download dialog
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
  "config.qrAlt": "Connection QR code",
  "config.qrHint": "Point your phone camera at the code — it opens AmneziaVPN",
  "config.qrZoom": "QR code size",
  "config.qrZoomHint":
    "Not scanning? Open the code full screen — on a monitor or a laptop screen that helps most.",
  "config.qrMaximize": "Show the code full screen",
  "config.qrFullscreen": "Full-screen QR code",
  "config.qrAudienceLabel": "What will you scan with?",
  "config.qrForCamera": "Phone camera",
  "config.qrForApp": "VPN app",
  "config.qrHintApp":
    "In the app (AmneziaVPN or Default VPN) tap Add → Scan QR code, then point it at this code",
  "config.qrAppWarning":
    "Only the app itself can read this code. A plain camera app cannot.",
  "config.qrSwitchToApp":
    "Scanning from inside the app (AmneziaVPN or Default VPN)? Open the code for the app",
  "config.qrSwitchToCamera":
    "Scanning with your phone's ordinary camera? Go back to the camera code",
  "config.qrFrameModeAria": "How the frames are shown",
  "config.qrFrameModeAnimated": "Animation",
  "config.qrFrameModeStatic": "Static",
  "config.qrFramesLoop":
    "The frames change by themselves and repeat in a loop — keep the camera on the code until the app has collected every frame",
  "config.qrFramesManual":
    "The frame is held still — step through the frames with the arrows until the app has collected every one",
  "config.qrFrameCounter": "Frame {current} of {total}",
  "config.qrFramePrev": "Previous frame",
  "config.qrFrameNext": "Next frame",
  "config.qrFramesFailed": "Could not load the code for the app",
  "config.qrFramesRetry": "Try again",
  "config.qrUnavailableTitle": "QR code is unavailable for this profile",
  "config.qrUnavailableWhy":
    "It is not about the size of the code: this profile carries thousands of routes, the key runs to 60 000 characters and more, and a QR code holds about 2 900. A key that long fits no code at all — not a large one, not a series of frames.",
  "config.qrUnavailableBody":
    "Copy the key with the button above and paste it into your client (Add → From string/file), or download the config file. Key operation on such profiles is not guaranteed.",

  // Install guide dialog (user page)
  "install.button": "How to connect",
  "install.title": "Install AmneziaVPN and connect",
  "install.desc":
    "Three steps: install the app, add the key, what to try if it does not work.",
  "install.opensNewTab": "Opens in a new tab",
  "install.latestVersion": "Latest version: {version}",
  "install.linksUnavailable":
    "Could not fetch the links. Reload the page or try again later.",
  "install.linksStale":
    "Could not check the release. The buttons open the releases page.",

  "install.installTitle": "Install the app",
  "install.platform.windows": "Windows",
  "install.platform.macos": "macOS",
  "install.platform.linux": "Linux",
  "install.platform.android": "Android",
  "install.platform.ios": "iPhone and iPad",
  "install.chooseTitle": "Choose your device",
  "install.showQr": "Show QR",
  "install.qrAlt": "QR code linking to the app",
  "install.qrHint":
    "Point your phone camera at it to open the app page.",
  "install.videoTitle": "Walkthrough video",
  "install.videoSoon": "A video will appear here.",
  "install.chooseHint": "Pick a device above.",
  "install.group.desktop": "Windows, macOS, Linux",
  "install.group.android": "Android",
  "install.group.ios": "iPhone and iPad (iOS)",
  "install.pickFile": "Pick the file for your system",
  "install.iosAmneziaTitle": "If your Apple account is not Russian",
  "install.iosAmneziaBody":
    "Then you can install AmneziaVPN itself — it does more. It is hidden from the Russian App Store.",
  "install.iosAmneziaOpen": "Open AmneziaVPN on the App Store",
  "install.desktopNote":
    "Run the downloaded file and follow the installer.",
  "install.iosNote":
    "In the Russian App Store the app is called Default VPN — install that one.",
  // Says only what is known. What a client does with a profile key on iOS has
  // not been checked on a device, and a claim a user acts on has to be one we
  // can stand behind.
  "install.iosProfileWarning":
    "Route profiles are not available on iPhone and iPad — create an “All traffic” key.",
  "install.versionNote":
    "AmneziaWG 3.1 keys work in client {version} or newer.",
  "install.apkTitle": "Google Play will not open?",
  "install.apkIntro":
    "Install the official AmneziaVPN APK from the releases page.",
  "install.apkStep1": "Tap the button below and wait for the download.",
  "install.apkStep2":
    "Open the downloaded file: the notification shade, or Files → Downloads.",
  "install.apkStep3":
    "Allow installing from the source if Android asks, then tap Install.",
  "install.apkDownload": "Download the APK",
  "install.apkOtherBuilds":
    "A 32-bit device, or Android 9-10? Pick the matching file on the release page.",

  "install.addTitle": "Add the key",
  "install.addStep1": "On the key card, press Copy.",
  "install.addStep2": "In the app: + → Insert, and paste the key.",
  "install.addStep3": "Tap Connect.",

  "install.confTitle": "The second way: a .conf file",
  "install.confBody":
    "The Download .conf button saves the key as a file. You open it in the app.",
  "install.confSplitBest":
    "Handy for the “Foreign only” and “Blocked only” profiles: that kind of key is very long, and the file only has to be opened once.",
  "install.confIosWarning":
    "It will not help on iPhone or iPad: the rules are not applied. There you need an “All traffic” key.",
  "install.confHow":
    "In AmneziaVPN: + → import a configuration file. The plain WireGuard app will not open it.",
  "install.confDomainsWarning":
    "A rule that names a site does not fit in the file — it holds only numeric addresses. To keep it, add the key by copying.",

  "install.fixTitle": "If it does not work",
  "install.fixServer": "Create a key on a different server.",
  "install.fixFullTunnel":
    "Try an “All traffic” key — that shows whether the problem is the network or the rules.",
  "install.fixAmneziaDns":
    "In AmneziaVPN's settings, turn off “Use Amnezia DNS servers”: with it on, the connection succeeds while no site opens.",
  "install.fixUpdate":
    "Update AmneziaVPN: an outdated client is a common cause.",
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
  "quota.willBecomeTotal": "Will become {total} across all servers",
  "quota.reason": "Reason",
  "quota.reasonPlaceholder":
    "For example: a work laptop and a phone, and not enough keys for both.",
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
  "ov.quotaTargetCoerced":
    "The request named \"{node}\". The limit is now shared, so approving raises the total.",
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
  "upolicy.showNodeAddress": "Server address",
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
  "users.limitNode": "Limits and servers:",
  "users.limitModeGlobalShort": "total",
  "users.limitModePerNodeShort": "per server",
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
  "users.purge":
    "Delete from panel",
  "users.purgeConfirm":
    "Delete the key “{{label}}” from the panel entirely? It is already gone from the node. The row and all of its traffic history disappear — only the audit event will remember it. This cannot be undone.",
  "users.revokeConfirm": "Revoke “{label}” permanently?",
  "users.internalName": "Internal name",
  "users.internalNamePrompt":
    "Internal name for this key. Administrators only — never shown to the user and never part of a configuration. Leave empty to clear it.",
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
  "users.limitMode": "Limit mode",
  "users.limitModeHint":
    "How this user's limit is counted: per server, or as one total across every server. Empty — as in the global policy.",
  "users.limitModeInherit": "As in the global policy ({mode})",
  "users.limitModePerNode": "Per server",
  "users.limitModeGlobal": "Total across all servers",
  "users.limitLabel": "Default limit on every server",
  "users.limitLabelHint": "Empty — the global limit ({value}).",
  "users.limitLabelGlobal": "Total key limit",
  "users.limitLabelGlobalHint":
    "Empty — the global limit ({value}). Counted across every server together.",
  "users.limitPerNodeDormant":
    "While the limit is shared, per-server limits are not applied. They are kept and come back when switched back.",
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
    "checks.resetHint":
    "Clear this check's stored results. Nothing is lost: the result IS the schedule, so every node measures it again on the next poll.",
  "checks.resetDone":
    "Results cleared — the nodes will measure the check again on the next poll.",
  "nodes.checks.all": "All checks",
 "checks.scope":
    "Every check runs on every node — the lines under it are what each one answered. There is no such thing as a check for one node.",
  "nodes.checks.title": "Services from this node",
  "nodes.checks.none":
    "This node has not answered any check yet. The usual cause is an agent older than 1.1.5, which does not serve the request.",
 "checks.title": "Service checks",
  "checks.cliHint":
    "The rule set is open, so checks are created and edited from the CLI: check-create, check-set. Here you can enable, run, and read what the nodes say.",
  "checks.empty": "No checks yet.",
  "checks.every": "every {minutes} min",
  "checks.run": "Run",
  "checks.runQueued":
    "Marked due: the nodes will run it on their next poll.",
  "checks.noResults": "No results yet.",
  "checks.deleteConfirm":
    "Delete the check “{name}” and every node's result for it?",
  "checks.loadFailed": "Failed to load the checks",
  "checks.actionFailed": "The action failed",
  "checks.state.works": "Works",
  "checks.state.unavailable": "Unavailable",
  "checks.state.unknown": "Unknown",
  "nodes.metrics.title": "Host metrics",
  "nodes.metrics.never": "This node has not answered yet — no metrics.",
  "nodes.metrics.ram": "Memory",
  "nodes.metrics.swap": "Swap",
  "nodes.metrics.disk": "Disk",
  "nodes.metrics.free": "free",
  "nodes.metrics.load": "Load / cores",
  "nodes.metrics.pids": "Agent tasks",
  "nodes.metrics.awg3": "AWG 3.1",
  "nodes.metrics.awg2": "AWG 2.0",
  "nodes.metrics.up": "up",
  "nodes.metrics.down": "down",
  "nodes.metrics.agentLatency": "Agent latency",
  "nodes.metrics.lastHandshake": "Last handshake",
  "nodes.metrics.handshakeAgo": "{minutes} min ago",
  "nodes.metrics.handshakeNever": "never",
  "gpolicy.showNodeStatus": "Show service status",
  "gpolicy.showNodeStatusHint":
    "Beside each server a user sees a service name and one of three words: works, unavailable, unknown. No address, no details.",
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
      "nodes.capacityChange": "Capacity",
    "nodes.capacityTip": "How many peers the node itself accepts. Changed on the node, not only in the panel.",
    "nodes.capacityTitle": "Capacity of {{name}}",
    "nodes.capacityBody": "The node rewrites its own .env and recreates only its agent. No tunnel drops and no peer is lost.",
    "nodes.capacityPeers": "Peers",
    "nodes.capacityRange": "1 to 500. Above 500 is an unvalidated configuration and is set on the node by hand.",
    "nodes.capacityNoDowntime": "Only the node-agent is recreated. The AWG containers are left alone, so existing connections keep working. If the agent does not come back healthy, the node restores the previous value itself.",
    "nodes.capacityLastFailure": "The last attempt failed: {{message}}",
    "nodes.capacityConfirm": "Apply",
    "nodes.capacityBusy": "Sending…",
    "nodes.capacityQueued": "Capacity change for {{name}} requested",
    "nodes.capacityFailed": "Could not request the capacity change",
"nodes.capacity": "Capacity",
  "nodes.traffic": "Traffic",
  "nodes.healthCheck": "Health check:",
  "nodes.sync": "Sync:",
  "nodes.reconcile": "Reconcile",
  "nodes.agentUpdate": "Update agent",
  "nodes.agentUpdateTip": "Install agent {version}. No tunnel drops: only the agent container is recreated",
  "nodes.agentUpdateUnresolved": "The panel has not resolved a published agent image yet",
  "nodes.agentUpdateTitle": "Update the agent on \u201c{name}\u201d",
  "nodes.agentUpdateBody": "The node pulls this image and recreates only its agent container. It installs exactly the digest shown here.",
  "nodes.agentUpdateRunning": "Running",
  "nodes.agentUpdateInstall": "Install",
  "nodes.agentUpdateVersion": "Version",
  "nodes.agentUpdateUnknown": "unknown",
  "nodes.agentUpdateNoDowntime": "The AWG containers are left alone, so no connection drops. If the new agent fails its health check the node rolls back to the previous digest.",
  "nodes.agentUpdateConfirm": "Update",
  "nodes.agentUpdateBusy": "Sending\u2026",
  "nodes.agentUpdateQueued": "Agent update requested on \u201c{name}\u201d",
  "nodes.agentUpdateFailed": "Could not request the update",
  "nodes.agentUpdateLog": "Update log",
  "nodes.agentUpdate.requested": "Agent update requested",
  "nodes.agentUpdate.running": "The agent is updating",
  "nodes.agentUpdate.succeeded": "Agent updated",
  "nodes.agentUpdate.failed": "The agent update failed",
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
  "nodes.publicAddress": "Public address",
  "nodes.publicAddressHint":
    "The address clients connect to (the node's SERVER_PUBLIC_HOST). The panel resolves the IP itself; if it cannot, the last known one is shown.",
  "nodes.publicAddressUnknown": "Not reported by the node yet",
  "nodes.publicAddressUnknownHint":
    "The node-agent on this node does not report publicHost — update its image.",
  "nodes.publicIpResolvedAt": "IP resolved {when}",
  "nodes.publicIpUnresolved": "IP not resolved",
  "nodes.publicIpUnresolvedHint":
    "The panel could not resolve this name to an IP at the last poll.",
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
  "gpolicy.showNodeAddress": "Show server address",
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
  "gpolicy.showNodeAddressHint":
    "Users see the address (IP or domain) of every server available to them. Off by default: the address is already in their config, but showing it in the panel is an admin's decision.",
  "gpolicy.keyLimitMode": "One limit shared by every server",
  "gpolicy.keyLimitModeHint":
    "On — the limit is counted across every server together. Off — separately on each server. Per-server limits are kept but not applied meanwhile. A single user's mode is set in \"Limits and servers\".",
  "policy.title": "Global portal policy",
  "policy.keyLimit": "Key limit per node",
  "policy.keyLimitHint":
    "How many keys a user gets per node by default. Individual users can have this overridden.",
  "policy.keyLimitGlobal": "Total key limit",
  "policy.keyLimitGlobalHint":
    "How many keys a user gets in total across every server by default. Individual users can have this overridden.",
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
  "policy.nodeOrder": "Server order",
  "policy.nodeOrderHint":
    "The order users see servers in — on the dashboard and when creating a key. Recommended servers always sit at the top of the list: tick one and it rises into that block on its own, while every other row keeps the state it had. Untick it and it drops just below the block. The badge widens nothing: a server a user may not use stays hidden from them even when it is recommended.",
  "policy.recommendToggle": "Recommend (raises the server to the top)",
  "policy.recommendedSummary": "Recommended: the first {count} of {total}",
  "policy.moveUp": "Move up",
  "policy.moveDown": "Move down",
  "policy.dragHint":
    "Drag a row to reorder it; the arrows do the same from a keyboard or a phone.",
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
  "audit.exact.admin.nodes.agent-update": "requested a node agent update",
  "audit.exact.node.agent-update.requested": "delivered an agent update request to a node",
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
