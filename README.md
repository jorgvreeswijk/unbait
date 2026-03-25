# Unbait

**See what articles are really about.**

[Website](https://unbait.link) | [Install](#quick-start) | [Privacy](#privacy)

Unbait is a browser extension that replaces clickbait headlines with clear, informative titles using AI. It works on news sites, blogs, and YouTube -- giving you honest headlines so you can decide what's actually worth reading.

## What It Does

Unbait sends article metadata (headline, description, URL) to the AI provider of your choice, which returns a straightforward, non-sensationalized title. You see the real story at a glance, without the emotional manipulation. On YouTube, it can also rewrite video titles and replace flashy thumbnails with neutral ones.

## Features

- **One-click de-clickbait** -- click the button and watch headlines transform
- **Always On mode** -- automatically de-clickbait your favorite sites on every visit
- **Multi-provider support** -- choose between Anthropic Claude (recommended), OpenAI GPT, or Google Gemini
- **YouTube support (Beta)** -- rewrite video titles, replace thumbnails with neutral frames, and use the transcript depth slider to control how deep the AI analyzes video content
- **Toggle original titles** -- click any rewritten headline to see the original
- **Per-provider caching** -- results are cached so you don't burn API credits on repeat visits
- **Privacy-first** -- no servers, no analytics, no tracking. Your data stays local or goes directly to your chosen AI provider

## Quick Start

1. **Install** the extension from the [Chrome Web Store](https://unbait.link) or build from source
2. **Get an API key** from your preferred AI provider ([Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google AI Studio](https://aistudio.google.com/))
3. **Paste your API key** in the extension settings
4. **Navigate to a news site** and click **De-clickbait!**

That's it. Headlines will be rewritten in place.

## Supported Browsers

| Browser | Status |
|---------|--------|
| Chrome | Supported |
| Safari | Supported |
| Brave | Supported |
| Edge | Supported |
| Opera | Supported |
| Other Chromium browsers | Should work |

## AI Providers

| Provider | Model | Best For |
|----------|-------|----------|
| **Anthropic Claude** (recommended) | Claude Haiku | Best quality, great at nuance |
| **OpenAI GPT** | GPT-4o Mini | Fast and reliable |
| **Google Gemini** | Gemini Flash | Free tier available |

You bring your own API key. Unbait never touches your key beyond sending it directly to the provider you chose.

## YouTube Support (Beta)

Unbait works on YouTube too:

- **Title rewriting** -- replaces sensationalized video titles with honest descriptions
- **Neutral thumbnails** -- swaps clickbait face thumbnails with a neutral frame from the video
- **Transcript depth slider** -- control how much of the video transcript the AI uses for analysis (more depth = more accurate titles, but uses more tokens)

YouTube frequently changes its DOM structure, so this feature is in beta. If something breaks, please [open an issue](https://github.com/jorgvreeswijk/Clickbeet/issues).

## Building from Source

### Chrome

1. Clone the repository:
   ```bash
   git clone https://github.com/jorgvreeswijk/Clickbeet.git
   cd Clickbeet
   ```
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder

### Safari

1. Clone the repository
2. Open the Xcode project in the `safari/` directory
3. Build and run in Xcode
4. Enable the extension in Safari > Settings > Extensions

No build system, no bundler, no npm. It's vanilla JS all the way down.

## How It Works

When you click De-clickbait (or visit a site with Always On enabled), Unbait:

1. Scans the page for article headlines and metadata
2. Sends the headline, description, and URL to your chosen AI provider
3. The AI returns a clear, factual title
4. Unbait replaces the headline in-place on the page
5. Results are cached locally so repeat visits are instant and free

For YouTube, Unbait extracts the video transcript (if available) and sends it along with the title for deeper analysis.

## Privacy

Unbait has **no backend servers, no analytics, and no tracking**.

- Your API key is stored locally in your browser
- Article data is sent directly from your browser to your chosen AI provider
- No data passes through any Unbait server
- No telemetry, no usage stats, nothing

Read the full [Privacy Policy](https://unbait.link/privacy).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on reporting bugs, suggesting features, and submitting code.

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for details. Do not open a public GitHub issue for security concerns.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Support

If Unbait saves you from clickbait, consider buying me a beer:

- **PayPal:** [paypal.me/unbaitlink](https://www.paypal.com/paypalme/unbaitlink)
- **GitHub Sponsors:** [github.com/sponsors/jorgvreeswijk](https://github.com/sponsors/jorgvreeswijk) (coming soon)

---

Built with coffee and AI by [Jorg Vreeswijk](https://github.com/jorgvreeswijk).

Unbait was vibe-coded with a lot of joy. Expect fast iterations and creative solutions.
