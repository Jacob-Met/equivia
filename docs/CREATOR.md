# Create a world pair by hand

Open **Create a pair by hand (new tab)** from the laboratory, or visit /creator. The worksheet lets you edit two candidate worlds, compare their observations and interventions, and export a world-pair file for the laboratory.

Your draft stays in the worksheet tab unless you explicitly save a file. There is no automatic worksheet saving; closing or reloading the tab does not preserve unsaved edits. Use **Save worksheet draft** to keep unfinished work, or **Export world pair** after the pair passes its checks.

## Start with matching lamps

The worksheet starts with an editable matching-lamps example. In World 1, A is set first and B follows A. In World 2, B is set first and A follows B. Both first lamps have a 50% chance of being on. The other lamp has a 0% chance of being on when the first is off, and a 100% chance when the first is on.

You can change the title, world names, rule order and chances. The rule order describes how the world is constructed; if the two conditional chances are equal, the first lamp has no effect on the other lamp.

Choose **Check world pair** to compare the worlds. Valid rules, matching observations, and a selected intervention that distinguishes the worlds are separate checks. Check again after editing: earlier results no longer describe the current draft.

## Save and resume unfinished work

Under **Keep your worksheet**, choose **Save worksheet draft** to request a download of `equivia-worksheet-draft.json`. Confirm that your browser has kept the file before closing the tab or replacing the worksheet. The page can request a download; it cannot guarantee that the file was saved to disk.

A worksheet draft keeps the title, world names, rule orders, probability selections and selected intervention. You can save blank names or a pair whose observations differ or whose selected clamp does not separate the worlds. Saving a draft does not certify the pair or run an investigation.

Choose **Open worksheet draft** to resume those editing values. A successfully opened draft replaces the current worksheet and clears previous check results. Save your current worksheet first if you want to keep it. Choose **Check world pair** again before exporting; a saved draft never carries permission to export a checked pair.

The file must have the supported `equivia.worksheet.v1` format and values this form can represent. Malformed or unsupported files leave the current worksheet intact. Editing the worksheet or selecting a newer file while a read is pending protects the newer work from the old result.

Keep the file types distinct:

| File | Where to open it | Purpose |
| --- | --- | --- |
| Worksheet draft | **Open worksheet draft** here | Resume unfinished editing |
| Checked world pair | **Open an authored world pair** here or in the laboratory | Edit a representable pair, or review it for a new investigation |
| Laboratory notebook | **Open notebook** in the laboratory | Resume an investigation and its evidence |

Saving or opening a worksheet draft does not write the laboratory's saved notebook, adopt a pair, or contact a model provider. There is no automatic draft recovery from browser storage.

The worksheet file is bounded to 65,536 UTF-8 bytes. Its top-level fields are `schema`, `title`, `worlds` and `clamp`. It contains exactly two worlds, each with `id`, `label`, `order`, `rootOn`, `childOff` and `childOn`. Titles and names preserve blank text and spaces, but must be single-line strings of at most 100 UTF-16 code units, matching the form's text-input limit. World IDs remain distinct letter-first identifiers of at most 40 letters, digits, hyphens or underscores. Orders are `AB` or `BA`; chances are integer eighths from 0 through 8; clamps are `A0`, `A1`, `B0` or `B1`. Missing or extra fields are rejected. Files contain editing values only, with no saved acceptance or investigation state.

## Try a noisy pair

Keep World 1's order as A → B and World 2's order as B → A. In both worlds, set:

- The first lamp's chance of being on to **50% (4/8)**.
- The other lamp's chance when the first is off to **25% (2/8)**.
- The other lamp's chance when the first is on to **75% (6/8)**.

Check the pair. With no intervention, both worlds have the same outcome distribution:

| Outcome (A, B) | Chance in either world |
| --- | --- |
| Off, off | 3/8 |
| Off, on | 1/8 |
| On, off | 1/8 |
| On, on | 3/8 |

Now inspect **Hold A on**. In World 1, B follows its conditional rule, so both lamps are on with probability **3/4**, and only A is on with probability **1/4**. In World 2, B is still set first with a 50% chance, so those two outcomes each have probability **1/2**.

The intervention gives different outcome distributions. A single observed outcome can still leave both worlds possible. These calculations establish properties of the entered finite rules, not educational efficacy or causes in an unrestricted real system.

## Export and open in the laboratory

After checking your current draft, choose **Export world pair** to download the existing authored-pair JSON format.

Before adopting the pair in the laboratory, save any investigation you want to keep. Laboratory tabs share the saved notebook; opening a separate tab does not isolate that storage.

In the laboratory, choose **Open an authored world pair**, select your exported file, and review it. Choose **Open as a new investigation** when you are ready to replace the current investigation with the authored pair. Exporting from the worksheet does not perform this adoption automatically.

## Reopen a saved pair

The worksheet's **Open an authored world pair** button loads a valid, representable pair back into the editing controls. Opening a supported file replaces the worksheet draft, so save a worksheet draft first if you want to keep your current edits.

Some valid laboratory files use random-input relationships that these probability controls cannot represent faithfully. The worksheet refuses those files rather than projecting them onto simpler rules. The original file remains usable through the laboratory's existing import flow.

An invalid or unsupported file leaves the draft intact. If you edit the draft or choose another file while a read is pending, an older file result will not overwrite the newer work. A successfully reopened pair needs a new explicit check before export.

## Representation limits

This worksheet uses two observed binary lamps and independent private random inputs. The editable chances advance in exact eighths; their joint outcome probabilities can have finer denominators. It compiles those chances into the existing authored-pair format; it does not change the laboratory engine, notebook format, model provider or scientific acceptance rules.

The two conditional probabilities use a shared random threshold within each variable. Reopening refuses a table that contains both an off-to-on and an on-to-off response when the parent changes under the same private input. Such a table can have matching intervention probabilities while expressing a richer response relationship. Naturally unobserved parent rows are still checked and preserved when representable.

Every accepted authored-pair reopen is checked against the original observational distribution and all eight nonempty A/B clamp assignments. The file may be recoded into equivalent threshold tables; original bytes, private random-input indices and identical same-seed sample sequences are not promised. This is a world-pair editor, not a notebook editor.

## Reproduce the browser course

The maintained source package includes review/creator-browser.mjs. With an existing puppeteer-core installation and sandbox-capable Chrome, run:

    PUPPETEER_MODULE=/absolute/path/to/puppeteer-core \
    CHROME_EXECUTABLE=/absolute/path/to/google-chrome \
    node review/creator-browser.mjs receipts/creator-browser

An optional third argument is a separate unchanged baseline source directory. The course uses actual loopback application entrypoints, downloads the exported pair, reopens it in the worksheet, and adopts and plays it through the maintained laboratory. Its delayed-read tests use explicit controlled barriers and preserve those tests as synthetic timing controls. The normal application does not contain those barriers.

No model connection is needed for manual authoring. Browser receiving, source/package checks and model execution remain distinct; no live NVIDIA/Nebius execution is established by this worksheet.

### Worksheet draft receiving

The focused worksheet course uses an existing Playwright installation and a running application. Start the application with `npm start`, then supply its printed loopback URL and a fresh evidence directory:

    BASE_URL=http://127.0.0.1:4192 \
    ARTIFACTS_DIR=/absolute/path/to/new-evidence \
    PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
    CHROME_PATH=/absolute/path/to/google-chrome \
    node review/worksheet-draft-browser.mjs

It downloads real worksheet files, checks unfinished-work round trips and rejected-file preservation, controls asynchronous file-read ordering, and exercises keyboard saving and the separate checked-pair adoption/play flow. It retains downloaded files, screenshots and `receipt.json`. It closes its own browser; stop the separately started application when finished. The native format tests run with the regular `npm test` course.
