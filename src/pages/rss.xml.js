import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const news = await getCollection('news');
  const sortedNews = news.sort((a, b) => {
    const da = a.data.date ? new Date(a.data.date).getTime() : 0;
    const db = b.data.date ? new Date(b.data.date).getTime() : 0;
    return db - da;
  });

  return rss({
    title: 'Квазар - Новости',
    description: 'Новости компании Квазар: подвесные потолки, теплоизоляция в Санкт-Петербурге',
    site: context.site,
    items: sortedNews.map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.date,
      description: entry.data.excerpt || '',
      link: `/novosti/${entry.slug}/`,
    })),
  });
}
