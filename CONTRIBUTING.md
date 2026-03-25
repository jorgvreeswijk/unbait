# Contributing to Unbait

Thanks for your interest in contributing! Unbait is a hobby project and every contribution -- big or small -- is appreciated.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/jorgvreeswijk/Clickbeet/issues) and include:

- **Browser** (Chrome, Safari, Brave, etc.) and version
- **AI provider** you're using (Claude, GPT, Gemini)
- **URL** where the issue occurred (if applicable)
- **What happened** vs. what you expected
- **Screenshots** if they help explain the problem

## Suggesting Features

Open a [GitHub Issue](https://github.com/jorgvreeswijk/Clickbeet/issues) with the label `enhancement`. Describe what you'd like to see and why it would be useful. Even rough ideas are welcome.

## Submitting Code

1. **Fork** the repository
2. **Create a branch** for your changes (`git checkout -b my-feature`)
3. **Make your changes**
4. **Test manually** in both Chrome and Safari before submitting
5. **Open a Pull Request** with a clear description of what you changed and why

### Code Style

- Vanilla JavaScript -- no frameworks, no build tools, no bundler
- Keep it simple and readable
- If you're not sure about something, look at the existing code for patterns

### Testing

There's no automated test suite (yet). Before submitting a PR:

- Test in **Chrome** (load unpacked extension)
- Test in **Safari** if possible
- Try your changes on a few different news sites
- If your changes touch YouTube functionality, test on YouTube too

### A Note on YouTube

YouTube changes its DOM structure frequently. If you're working on YouTube-related code, please test thoroughly and be aware that selectors may need updating over time. YouTube PRs get extra scrutiny -- not because we don't trust you, but because YouTube is a moving target.

## Code of Conduct

Be kind. Be constructive. We're all here because we don't like clickbait, not because we want to argue on the internet.

---

Thanks for helping make the web a little more honest.
