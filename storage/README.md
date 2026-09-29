# Book files

Put each book's files here before launch (they are git-ignored):

```
storage/books/ai-control-center/ai-control-center.epub
storage/books/ai-control-center/ai-control-center.pdf
storage/books/automate-channel-ai/automate-channel-ai.epub
storage/books/automate-channel-ai/automate-channel-ai.pdf
storage/books/first-ai-workflow-weekend/first-ai-workflow-weekend.epub
storage/books/first-ai-workflow-weekend/first-ai-workflow-weekend.pdf
storage/covers/<slug>.jpg   (optional; shown in /shelf and on the web page)
```

PDFs are stamped with the buyer id (Telegram) or order id (web) at delivery time. EPUBs are sent as-is and
their Telegram `file_id` is cached, so replacing a file (new mtime) automatically re-uploads it.

A book-specific free chapter can go in `content/samples/<slug>/` with a `files.json` listing its files;
otherwise the lead magnet in `content/samples/lead-magnet/` is used.
