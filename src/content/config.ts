import { defineCollection, z } from 'astro:content';

const breadcrumbSchema = z.object({
  title: z.string(),
  href: z.string(),
});

const seoSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    keywords: z.string().optional(),
  })
  .partial()
  .optional();

const products = defineCollection({
  type: 'data',
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    h1: z.string(),
    description: z.string().optional(),
    specs: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
        }),
      )
      .default([]),
    priceLabel: z.string().optional(),
    priceValue: z.number().nullable().optional(),
    images: z.array(z.string()).default([]),
    gallery: z.array(z.string()).optional(),
    category: z.string(),
    brand: z.string().optional(),
    breadcrumbs: z.array(breadcrumbSchema).default([]),
    seo: seoSchema,
    sourceUrl: z.string().optional(),
    scrapedAt: z.string().optional(),
  }),
});

const categories = defineCollection({
  type: 'data',
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    parent: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    sortOrder: z.number().optional(),
    breadcrumbs: z.array(breadcrumbSchema).optional(),
    seo: seoSchema,
    sourceUrl: z.string().optional(),
    scrapedAt: z.string().optional(),
  }),
});

const brands = defineCollection({
  type: 'data',
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    description: z.string().optional(),
    logo: z.string().optional(),
    inCategory: z.array(z.string()).optional(),
    breadcrumbs: z.array(breadcrumbSchema).optional(),
    seo: seoSchema,
    sourceUrl: z.string().optional(),
    scrapedAt: z.string().optional(),
  }),
});

const news = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    draft: z.boolean().optional().default(false),
    sourceUrl: z.string().optional(),
    seo: seoSchema,
  }),
});

const objects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date().optional(),
    excerpt: z.string().optional(),
    location: z.string().optional(),
    image: z.string().optional(),
    images: z.array(z.string()).optional(),
    draft: z.boolean().optional().default(false),
    sourceUrl: z.string().optional(),
    seo: seoSchema,
  }),
});

const articles = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date().optional(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    draft: z.boolean().optional().default(false),
    sourceUrl: z.string().optional(),
    seo: seoSchema,
  }),
});

const certificates = defineCollection({
  type: 'data',
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    category: z.string().optional(),
    image: z.string(),
    pdf: z.string().optional(),
    sortOrder: z.number().optional(),
    sourceUrl: z.string().optional(),
    scrapedAt: z.string().optional(),
  }),
});

export const collections = {
  products,
  categories,
  brands,
  news,
  objects,
  certificates,
  articles,
};
