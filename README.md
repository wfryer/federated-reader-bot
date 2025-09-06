# Federated Reader Bot

## Turn Your Gmail Newsletters into a Personal Mastodon Feed

This Google Apps Script transforms your email newsletters into a dynamic, self-hosted news feed on Mastodon. It automatically finds new newsletters in your Gmail, extracts the primary article link, formats a post with the title, author, and date, and shares it to your designated Mastodon account. It's a powerful tool for taking control of your content and creating a personalized reader using the power of the fediverse.

This project embraces the spirit of #OwnYourFeed.

## About This Project

This script is more than just a utility; it's an experiment in reclaiming our information diets from algorithmic control. In an era of increasing political polarization, many of us have lost trusted local news sources and find our feeds filled with divisive content. This project is a small step toward a solution.

By empowering individuals to curate their own feeds from trusted voices, we can focus more on substantive issues and less on manufactured outrage. This is part of a broader effort to:
* Document practical applications of AI on ["Learning AI with Wes Fryer"](https://ai.wesfryer.com).
* Promote digital literacy and constructive dialogue through the ["Heal Our Culture" project](https://healourculture.org).

This tool is for anyone who wants to be a "culture healer, not a culture warrior" by taking proactive control of their digital consumption.

## Features

* **Automated Polling:** Runs on a schedule to check for new newsletters in Gmail.
* **Intelligent Link-Finding:** Uses a sophisticated scoring system to find the *actual* article link and ignore unsubscribe, ad, or "read in app" links.
* **Smart De-duplication:** Remembers which articles it has already posted to prevent duplicate shares.
* **Custom Formatting:** Posts are cleanly formatted with the article title, author, date, link, and relevant hashtags.
* **Error Notifications:** Automatically emails you if the script fails to post to Mastodon.

## Setup Instructions

Follow these steps to get your own Federated Reader Bot running.

#### 1. Create the Google Apps Script Project
* Go to [script.google.com](https://script.google.com) and create a new project.
* Give your project a name (e.g., "Federated Reader Bot").
* Delete the default content in the `Code.gs` file and paste in the entire code from the `Code.gs` file in this repository.

#### 2. Enable the Gmail API
* In the Apps Script editor, click **Services** on the left sidebar.
* Click **+ Add a service**.
* Select **Gmail API** from the list and click **Add**.

#### 3. Set Script Properties
* In the Apps Script editor, click **Project Settings** (the gear icon ⚙️) on the left sidebar.
* Under "Script Properties," click **Edit script properties**.
* Click **+ Add script property** and add the following two properties:
    * **Property:** `MASTODON_BASE_URL` | **Value:** `https://your.mastodon.instance` (e.g., `https://mastodon.social`)
    * **Property:** `MASTODON_TOKEN` | **Value:** Your Mastodon Access Token. (You can generate this in your Mastodon account under `Preferences > Development > New Application`).

#### 4. Run the One-Time Setup
* In the Apps Script editor, select the `setup_` function from the dropdown menu at the top and click **Run**.
* You will be prompted to grant permissions. Review and authorize them. This initializes the script's memory.

#### 5. Set Up the Automation Trigger
* Click the **Triggers** icon (the clock ⏰) on the left sidebar.
* Click **+ Add Trigger** and set it up as follows:
    * Function to run: `run`
    * Event source: `Time-driven`
    * Type of time-based trigger: `Hour timer`
    * Hour interval: `Every hour`
* Click **Save**.

#### 6. Create the Gmail Filter
* In Gmail, create a filter that finds your newsletters and applies a specific label (e.g., "Newsletters").
* A powerful "catch-all" query to start with is: `("powered by ghost" OR "substack" OR "mailchimp")`.
* When creating the filter, be sure to check **Apply the label:** and **Also apply filter to matching conversations.**

## Credit and Collaboration

This project was created by Wes Fryer. You can explore more of his work on [GitHub](https://github.com/wfryer/).

This script was developed in a "vibe coding" collaboration with **Google's Gemini**. Its step-by-step guidance, debugging assistance, and code generation were instrumental in bringing this project to life.

## License

This project is licensed under the MIT License.
