// Initial catalog: Drop Shelf's first three drops (AI and workflow automations) plus the bundle.
export const CATALOG = [
  {
    slug: 'ai-control-center',
    title: 'Telegram as Your AI Control Center',
    short_title: 'Telegram AI Control Center',
    pitch: 'Run your day from a Telegram bot: 8–10 tested n8n workflows for daily briefs, inbox triage and approvals.',
    description:
      '8–10 tested n8n workflows you run from a Telegram bot: daily brief, inbox triage, content drafts with approve/reject, invoice extraction, lead capture. EPUB + PDF + importable JSON.',
    audience: 'Solo founders, freelancers',
    launch_price_stars: 300,
    full_price_stars: 450,
    is_current_drop: 1,
    sort_order: 1,
  },
  {
    slug: 'automate-channel-ai',
    title: 'Automate Your Telegram Channel with AI',
    short_title: 'Automate Your Channel with AI',
    pitch: 'A content pipeline that drafts, schedules, repurposes and moderates your channel while you sleep.',
    description:
      'Content pipeline, scheduled posting, repurposing, comment moderation and Stars sales alerts for Telegram channel owners. EPUB + PDF.',
    audience: 'Channel owners',
    launch_price_stars: 200,
    full_price_stars: 300,
    is_current_drop: 0,
    sort_order: 2,
  },
  {
    slug: 'first-ai-workflow-weekend',
    title: 'Zapier vs Make vs n8n: Ship Your First AI Workflow in a Weekend',
    short_title: 'Your First AI Workflow',
    pitch: 'Pick the right tool, know the costs, and ship one AI workflow built three ways by Sunday night.',
    description:
      'Beginner guide: choosing between Zapier, Make and n8n, what each costs, and one AI workflow built three ways. EPUB + PDF.',
    audience: 'Beginners',
    launch_price_stars: 100,
    full_price_stars: 150,
    is_current_drop: 0,
    sort_order: 3,
  },
  {
    slug: 'drop-shelf-bundle',
    kind: 'bundle',
    title: 'The Drop Shelf Bundle (all 3 books)',
    short_title: 'Drop Shelf Bundle (3 books)',
    pitch: 'All three AI automation guides in one purchase.',
    description: 'All three Drop Shelf guides: AI Control Center, Automate Your Channel with AI, and Ship Your First AI Workflow. EPUB + PDF of each.',
    audience: 'Everyone',
    launch_price_stars: 600,
    full_price_stars: 600,
    is_current_drop: 0,
    sort_order: 4,
    bundle_slugs: ['ai-control-center', 'automate-channel-ai', 'first-ai-workflow-weekend'],
  },
];

export function seedCatalog(db, now = Date.now()) {
  const insert = db.prepare(`
    INSERT INTO books (slug, kind, title, short_title, pitch, description, audience,
      launch_price_stars, full_price_stars, is_current_drop, active, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(slug) DO NOTHING`);
  for (const b of CATALOG) {
    insert.run(b.slug, b.kind || 'book', b.title, b.short_title, b.pitch, b.description, b.audience,
      b.launch_price_stars, b.full_price_stars, b.is_current_drop, b.sort_order, now);
  }
  const idOf = db.prepare('SELECT id FROM books WHERE slug = ?');
  const setItems = db.prepare('UPDATE books SET bundle_items = ? WHERE slug = ? AND bundle_items IS NULL');
  for (const b of CATALOG.filter((x) => x.bundle_slugs)) {
    setItems.run(JSON.stringify(b.bundle_slugs.map((s) => idOf.get(s).id)), b.slug);
  }
}
