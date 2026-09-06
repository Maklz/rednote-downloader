const listEl = document.querySelector('#list');
const summaryEl = document.querySelector('#summary');
const historyEl = document.querySelector('#history');
const historyListEl = document.querySelector('#historyList');

function formatDuration(seconds) {
  if (!seconds) {
    return '';
  }

  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function formatSize(bytes) {
  if (!bytes) {
    return '';
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatMeta(entry) {
  return [
    entry.author,
    formatDuration(entry.duration),
    entry.width && entry.height ? `${entry.width}×${entry.height}` : '',
    formatSize(entry.sizeBytes),
    entry.uploadDate,
    entry.topic,
  ].filter(Boolean).join(' · ');
}

// Everything here comes from a video the reviewer did not write, so titles and
// author names are set as text and never as markup.
function buildCard(entry) {
  const card = document.createElement('article');
  card.className = 'card';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.alt = '';
  if (entry.thumbnail) {
    thumb.src = entry.thumbnail;
  }

  const body = document.createElement('div');

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = entry.title;

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = formatMeta(entry);
  meta.append(document.createElement('br'));

  const link = document.createElement('a');
  link.href = entry.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Открыть оригинал';
  meta.append(link);

  const row = document.createElement('div');
  row.className = 'row';

  const caption = document.createElement('input');
  caption.type = 'text';
  caption.placeholder = 'Подпись к посту (необязательно)';
  caption.value = entry.caption || '';

  const publish = document.createElement('button');
  publish.className = 'publish';
  publish.textContent = 'Опубликовать';

  const reject = document.createElement('button');
  reject.className = 'reject';
  reject.textContent = 'Отклонить';

  const status = document.createElement('div');
  status.className = 'status';
  if (entry.error) {
    status.classList.add('error');
    status.textContent = entry.error;
  }

  async function decide(action) {
    publish.disabled = true;
    reject.disabled = true;
    status.className = 'status';
    status.textContent = action === 'reject' ? 'Отклоняю…' : 'Публикую, это может занять минуту…';

    try {
      const response = await fetch(`/api/queue/${encodeURIComponent(entry.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, caption: caption.value.trim() }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `Ошибка ${response.status}`);
      }

      card.remove();
      await refresh();
    } catch (error) {
      status.classList.add('error');
      status.textContent = error instanceof Error ? error.message : 'Не получилось';
      publish.disabled = false;
      reject.disabled = false;
    }
  }

  publish.addEventListener('click', () => decide('publish'));
  reject.addEventListener('click', () => decide('reject'));

  row.append(caption, publish, reject);
  body.append(title, meta, row, status);
  card.append(thumb, body);
  return card;
}

async function refresh() {
  try {
    const response = await fetch('/api/queue');
    const data = await response.json();

    if (!data?.ok) {
      throw new Error(data?.error || 'Не удалось получить очередь');
    }

    listEl.replaceChildren();

    if (!data.channelConfigured) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = 'Канал для публикации не настроен — кнопка «Опубликовать» работать не будет.';
      listEl.append(warn);
    }

    summaryEl.textContent = data.pending.length
      ? `Ждут решения: ${data.pending.length}`
      : 'Пока ничего не ждёт решения.';

    if (!data.pending.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Новых вариантов нет. Страница обновляется сама.';
      listEl.append(empty);
    }

    for (const entry of data.pending) {
      listEl.append(buildCard(entry));
    }

    historyListEl.replaceChildren();
    for (const entry of data.decided) {
      const item = document.createElement('li');
      item.textContent = `${entry.status === 'published' ? 'опубликовано' : 'отклонено'} — ${entry.title}`;
      historyListEl.append(item);
    }
    historyEl.hidden = data.decided.length === 0;
  } catch (error) {
    summaryEl.textContent = error instanceof Error ? error.message : 'Ошибка загрузки';
  }
}

refresh();
// New candidates arrive without the page being touched, so it looks for them
// on its own rather than waiting to be reloaded.
setInterval(refresh, 15000);
