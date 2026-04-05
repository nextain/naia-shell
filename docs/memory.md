# Naia Memory System — User Guide

Naia remembers things about you across conversations. This guide explains what is stored, where, and how to manage it.

[한국어](memory.ko.md)

---

## What Does Naia Remember?

Naia automatically extracts facts from your conversations — things you say about yourself, your preferences, and your decisions.

**Examples of facts Naia learns:**
- "I'm a frontend developer"
- "I always use Figma for design"
- "I prefer dark mode"
- "My project stack is Next.js + FastAPI"

Not every message is stored. Naia uses an importance score (novelty, relevance, emotional weight) to decide what's worth keeping.

---

## Where Is It Stored?

All memory is stored **locally on your machine**:

```
~/.naia/memory/alpha-memory.json
```

**Nothing is sent to Nextain's servers** — not your conversations, not your facts, not your preferences. The memory file never leaves your device unless you explicitly back it up.

---

## How Memory Works

Naia's memory has four layers:

| Layer | What it does |
|-------|-------------|
| **Episodes** | Raw conversation turns (what you said, when) |
| **Facts** | Distilled knowledge extracted from episodes (your preferences, decisions) |
| **Reflections** | Lessons Naia learned from past failures |
| **Working Memory** | Active context for the current session |

**The consolidation cycle:**
1. During a conversation, important messages are stored as **episodes**
2. Every 30 minutes (or after 5 minutes if inactive), Naia "thinks about its day" and extracts **facts** from episodes
3. When you start a new conversation, relevant facts and recent episodes are loaded as context

---

## Managing Your Memory

### View Your Facts

Open **Settings → Memory** in the Naia app. You'll see a list of all facts Naia has extracted about you.

### Delete a Fact

In **Settings → Memory**, click the delete (🗑) button next to any fact you want to remove.

### Clear All Memory

In **Settings → Memory**, use **"Clear All"** to delete everything. Naia will start fresh.

You can also delete the file directly:

```bash
rm ~/.naia/memory/alpha-memory.json
```

---

## Backup and Restore

### Manual Backup

Copy the memory file to a safe location:

```bash
cp ~/.naia/memory/alpha-memory.json ~/Documents/naia-memory-backup-$(date +%Y%m%d).json
```

### Restore from Backup

```bash
cp ~/Documents/naia-memory-backup-YYYYMMDD.json ~/.naia/memory/alpha-memory.json
```

Restart the Naia app after restoring.

### Transfer to a New Machine

Copy `~/.naia/memory/alpha-memory.json` to the same path on your new machine. Naia will resume with your full memory intact.

---

## Privacy

- Memory is stored as plain JSON on your local filesystem
- No encryption is applied by default (your filesystem permissions protect it)
- Nextain never has access to your memory data
- If you uninstall Naia, the memory file remains at `~/.naia/memory/` — delete it manually if desired

---

## Frequently Asked Questions

**Q: Why doesn't Naia remember something I said?**

Not all messages are stored — only those above an importance threshold. Very short, casual, or low-novelty messages may not be captured. You can state important facts explicitly: "Remember that I use TypeScript."

**Q: Naia remembered something incorrectly — how do I fix it?**

Open Settings → Memory, find the incorrect fact, and delete it. Then tell Naia the correct information and it will be stored in the next consolidation cycle (within 30 minutes, or after 5 minutes if the session goes inactive).

**Q: Can I see the raw memory file?**

Yes — it's plain JSON at `~/.naia/memory/alpha-memory.json`. You can read or edit it with any text editor.

**Q: Does memory affect performance?**

At typical scale (hundreds of facts), memory recall adds less than 50ms to session startup. The consolidation cycle runs in the background and does not affect conversation latency.
