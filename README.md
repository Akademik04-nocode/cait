# kvazarcomp-site

Modern rebuild of [kvazarcomp.ru](https://kvazarcomp.ru) as a static Astro site.

---

## Что это

Статический сайт компании **Квазар** (Санкт-Петербург) - поставщик строительных
материалов: подвесные потолки, теплоизоляция, OSB, смеси Vetonit, гипсокартон.

Сайт собран на [Astro 4](https://astro.build/) + TypeScript + TailwindCSS.
Контент перенесен с оригинального сайта kvazarcomp.ru (работающего на IVPRO CMS)
через скрейпинг из Wayback Machine. Результат - полностью статический сайт,
который можно разместить на любом хостинге (GitHub Pages, Netlify, Cloudflare
Pages, обычный FTP).

---

## Локальная разработка

```bash
npm install       # установить зависимости
npm run dev       # запустить dev-сервер Astro (http://localhost:4321)
```

Dev-сервер поддерживает hot-reload: изменения в шаблонах, стилях и контенте
отображаются мгновенно.

---

## Обновление контента

Контент сайта хранится в `src/content/` в формате JSON и Markdown. Для обновления
используется встроенный скрейпер:

```bash
npm run scrape
```

Скрейпер загружает HTML-страницы через Wayback Machine (web.archive.org), так как
оригинальный сервер может быть недоступен. Полученные данные сохраняются в:

- `src/content/products/` - карточки товаров (JSON)
- `src/content/categories/` - категории каталога (JSON)
- `src/content/brands/` - бренды (JSON)
- `src/content/news/` - новости (Markdown)
- `src/content/objects/` - объекты (Markdown)
- `src/content/certificates/` - сертификаты (JSON)
- `src/content/articles/` - статьи (Markdown)
- `public/images/` - изображения товаров и сертификатов

### Флаги скрейпера

| Флаг | Описание |
|------|----------|
| `--limit=N` | Обработать только N URL из карты сайта |
| `--refresh` | Перезагрузить все страницы, игнорируя кеш |
| `--only=URL` | Обработать только указанный URL |

Примеры:

```bash
npm run scrape -- --limit=10           # только 10 страниц (для теста)
npm run scrape -- --refresh            # обновить все, не используя кеш
npm run scrape -- --only=/katalog/armstrong/  # обновить одну страницу
```

Кеш HTML-страниц хранится в `.scrape-cache/` (добавлен в .gitignore).

---

## Сборка для продакшена

```bash
npm run build              # astro check + astro build -> dist/
node scripts/smoke.mjs     # пост-сборочная проверка
```

Команда `npm run build` выполняет проверку типов (`astro check`) и сборку в
папку `dist/`. Smoke-тест проверяет:

- Наличие index.html, 404.html, robots.txt, sitemap
- Корректность страницы контактов (телефон, почтовый индекс)
- Минимум 50 страниц товаров в каталоге
- Наличие JSON-LD разметки на страницах товаров
- Отсутствие "undefined" и "[object Object]" в тексте страниц

---

## Деплой

### Вариант 1: GitHub Pages (рекомендуется)

В репозитории уже настроен workflow `.github/workflows/pages.yml`. При пуше в
ветку `main` сайт автоматически собирается и публикуется на GitHub Pages.

Для активации:
1. Перейдите в Settings > Pages вашего репозитория
2. В разделе Source выберите "GitHub Actions"
3. Следующий пуш в main запустит деплой

### Вариант 2: Netlify

1. Подключите репозиторий в Netlify
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Файл `public/_redirects` уже настроен для корректной работы

### Вариант 3: FTP/SFTP

Загрузите содержимое папки `dist/` на ваш сервер. Все файлы статические,
серверная обработка не требуется.

---

## Форма обратной связи

Форма на странице контактов может работать через внешний сервис (Formspree,
Web3Forms) или как простая mailto-ссылка.

Настройка через переменные окружения (файл `.env`):

```env
# URL сервиса обработки форм
PUBLIC_FORM_ENDPOINT=https://formspree.io/f/xxxxxxxx

# Fallback email (используется если PUBLIC_FORM_ENDPOINT не задан)
PUBLIC_CONTACT_EMAIL=info@kvazarcomp.ru
```

Если `PUBLIC_FORM_ENDPOINT` не задан, форма отправляется через `mailto:` на
адрес `PUBLIC_CONTACT_EMAIL`. Пример конфигурации см. в `.env.example`.

---

## Структура проекта

```
kvazarcomp-site/
├── src/
│   ├── components/       # Astro-компоненты (Header, Footer, ProductCard...)
│   ├── content/          # Контент сайта (JSON, Markdown)
│   │   ├── products/     # Товары каталога
│   │   ├── categories/   # Категории
│   │   ├── brands/       # Бренды
│   │   ├── news/         # Новости
│   │   ├── certificates/ # Сертификаты
│   │   └── config.ts     # Схемы коллекций
│   ├── layouts/          # Базовый layout
│   ├── pages/            # Маршруты (index, katalog, kontakty...)
│   └── styles/           # Глобальные стили
├── public/
│   ├── images/           # Изображения (скачанные скрейпером)
│   └── _redirects        # Редиректы для Netlify
├── scripts/
│   ├── scrape.mjs        # Скрейпер контента
│   ├── smoke.mjs         # Пост-сборочный smoke-тест
│   └── gen-redirects.mjs # Генератор файла редиректов
├── .github/workflows/
│   ├── pages.yml         # Деплой на GitHub Pages
│   └── scrape.yml        # Ручное обновление контента
├── astro.config.mjs      # Конфигурация Astro
├── tailwind.config.mjs   # Конфигурация TailwindCSS
└── package.json
```

---

## Решение проблем

### Скрейпер завершается с ошибками

Если часть страниц не загрузилась, ошибки записываются в `scrape-errors.log`.
Проверьте лог и повторите загрузку для конкретных URL:

```bash
# Посмотреть ошибки
cat scrape-errors.log

# Повторить загрузку конкретной страницы
npm run scrape -- --only=/katalog/armstrong/ --refresh
```

Типичные причины ошибок:
- Wayback Machine временно недоступен (попробуйте позже)
- Страница отсутствует в архиве (404 от Wayback)
- Таймаут сети (повторите запрос)

### Ошибки сборки

```bash
npm run check    # проверить типы и диагностику Astro
npm run build    # полная сборка с проверками
```

Если `astro check` сообщает об ошибках в content collections, убедитесь что
`src/content/config.ts` соответствует структуре данных в JSON-файлах.

---

## О контенте

Контент сайта является зеркалом kvazarcomp.ru и принадлежит компании
ООО "Квазар" (Санкт-Петербург). Изображения, тексты описаний товаров,
сертификаты и прочие материалы используются с разрешения владельца бизнеса.

---

## Лицензия

Исходный код проекта распространяется под лицензией MIT.
Контент (тексты, изображения) принадлежит ООО "Квазар".
