import { describe, expect, it } from "vitest";
import { appTitle } from "./App";

describe("App shell", () => {
  it("exposes the HexDeck title", () => {
    expect(appTitle).toBe("HexDeck");
  });
});
