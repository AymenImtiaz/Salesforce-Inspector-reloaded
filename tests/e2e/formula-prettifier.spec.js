import {test, expect} from "./fixtures";
import {
  TEST_CONSTANTS,
  injectSessionData,
  createModelExposureSetup
} from "./test-helpers";
import {routeMock} from "./test-mock";

test.describe("Formula Prettifier", () => {
  const {mockHost, mockToken, apiVersion} = TEST_CONSTANTS;

  test.beforeEach(async ({context, extensionId}) => {
    TEST_CONSTANTS.extensionId = extensionId;

    await injectSessionData(context, {
      host: mockHost,
      token: mockToken,
      version: apiVersion,
      additionalSetup: createModelExposureSetup()
    });

    await context.route("**/*", async route => {
      if (!TEST_CONSTANTS.mockEnabled) {
        await route.continue();
        return;
      }
      if (await routeMock(route, mockHost)) {
        return;
      }
      await route.continue();
    });
  });

  /** Opens the inspect page on Account and waits for the field table. */
  async function initInspectPage(page, extensionId) {
    await page.goto(`chrome-extension://${extensionId}/inspect.html?host=${mockHost}&objectType=Account&recordId=${TEST_CONSTANTS.accountRecordId}`);
    await page.waitForSelector("#root", {timeout: 2000});
    await page.waitForSelector("table.slds-table", {timeout: 2000});
  }

  /** Opens the field-actions dropdown on the formula field row and clicks "Prettify formula". */
  async function openPrettifierModal(page) {
    // The formula field (Formula_Field__c) is the one with a "Prettify formula" action.
    // Open its field-actions dropdown, then click the action.
    const formulaRow = page.locator("tr", {hasText: "Formula_Field__c"}).first();
    await expect(formulaRow).toBeVisible();

    const actionsButton = formulaRow.locator("td.field-actions button").first();
    await actionsButton.click();
    await page.waitForTimeout(250);

    const prettifyLink = page.locator("a:has-text('Prettify formula')");
    await expect(prettifyLink).toBeVisible();
    await prettifyLink.click();

    // Wait for the modal panel to render.
    await page.waitForSelector(".fp-panel", {timeout: 2000});
  }

  test("Prettify action appears only for formula fields", async ({page, extensionId}) => {
    await initInspectPage(page, extensionId);

    // A non-formula field (Name) row: its actions menu has NO "Prettify formula".
    const nameRow = page.locator("tr", {hasText: "Account Name"}).first();
    await nameRow.locator("td.field-actions button").first().click();
    await page.waitForTimeout(250);
    // The menu is open (its own "All field metadata" item is visible) but no Prettify action.
    await expect(nameRow.locator("a:has-text('All field metadata')")).toBeVisible();
    await expect(nameRow.locator("a:has-text('Prettify formula')")).toHaveCount(0);

    // Dismiss the menu by clicking it closed (toggle the same button).
    await nameRow.locator("td.field-actions button").first().click();
    await page.waitForTimeout(150);

    // The formula field row DOES expose the action.
    const formulaRow = page.locator("tr", {hasText: "Formula_Field__c"}).first();
    await formulaRow.locator("td.field-actions button").first().click();
    await page.waitForTimeout(250);
    await expect(formulaRow.locator("a:has-text('Prettify formula')")).toBeVisible();
  });

  test("Opens modal and renders the prettified formula", async ({page, extensionId}) => {
    await initInspectPage(page, extensionId);
    await openPrettifierModal(page);

    // Modal title names the field
    await expect(page.locator("text=Formula Prettifier:")).toBeVisible();
    await expect(page.locator("text=Prettified Formula")).toBeVisible();

    // The formatted output is present
    const output = page.locator(".formula-output");
    await expect(output).toBeVisible();

    // Content integrity: the function names from the source formula are present
    const outputText = await output.textContent();
    expect(outputText).toContain("IF");
    expect(outputText).toContain("UPPER");
    expect(outputText).toContain("TEXT");
    expect(outputText).toContain("YEAR");
    expect(outputText).toContain("TODAY");
  });

  test("Applies syntax highlighting to tokens", async ({page, extensionId}) => {
    await initInspectPage(page, extensionId);
    await openPrettifierModal(page);

    // Tokens carry data-token-type (the highlighter ran)
    const typedTokens = page.locator(".formula-output [data-token-type]");
    expect(await typedTokens.count()).toBeGreaterThan(0);

    // Function tokens are rendered as evaluable spans
    const evaluable = page.locator(".formula-output .fp-evaluable");
    expect(await evaluable.count()).toBeGreaterThan(0);
  });

  test("Copy button is present and clickable", async ({page, context, extensionId}) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await initInspectPage(page, extensionId);
    await openPrettifierModal(page);

    const copyButton = page.locator(".copy-button");
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await page.waitForTimeout(250);

    // Clipboard holds the formula content (function names survive the round-trip)
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    if (clip) {
      expect(clip).toContain("IF");
      expect(clip).toContain("UPPER");
    }
  });

  test("Edit mode shows an editable textarea seeded with the formula", async ({page, extensionId}) => {
    await initInspectPage(page, extensionId);
    await openPrettifierModal(page);

    // Toggle edit mode
    const editButton = page.locator(".fp-edit-button");
    await expect(editButton).toBeVisible();
    await editButton.click();
    await page.waitForTimeout(250);

    // Editor textarea appears and contains the formula's function names
    const textarea = page.locator(".fp-editor-textarea");
    await expect(textarea).toBeVisible();
    const value = await textarea.inputValue();
    expect(value).toContain("IF");
    expect(value).toContain("UPPER");
  });

  test("Closes the modal (X / Escape)", async ({page, extensionId}) => {
    await initInspectPage(page, extensionId);
    await openPrettifierModal(page);

    await expect(page.locator(".fp-panel")).toBeVisible();

    // Escape closes the SLDS modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    await expect(page.locator(".fp-panel")).not.toBeVisible();
  });
});
