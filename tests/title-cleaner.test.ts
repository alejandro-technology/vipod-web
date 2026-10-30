import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanYouTubeTitle, isPunctuationOnly, sanitizeSearchQuery } from "../src/lib/title-cleaner";

describe("title cleaner", () => {
  it("strips common YouTube noise patterns from titles", () => {
    assert.deepEqual(
      cleanYouTubeTitle("Queen – Bohemian Rhapsody (Official Video Remastered)"),
      {
        cleaned: "Queen - Bohemian Rhapsody",
        artist: "Queen",
        title: "Bohemian Rhapsody",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("Coldplay - Yellow (Official Video)"),
      {
        cleaned: "Coldplay - Yellow",
        artist: "Coldplay",
        title: "Yellow",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("Gustavo Cerati - Crimen (Video Oficial) [Remasterizado 2021]"),
      {
        cleaned: "Gustavo Cerati - Crimen",
        artist: "Gustavo Cerati",
        title: "Crimen",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("Bad Bunny - Tití Me Preguntó (Video Oficial) | Un Verano Sin Ti"),
      {
        cleaned: "Bad Bunny - Tití Me Preguntó",
        artist: "Bad Bunny",
        title: "Tití Me Preguntó",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers"),
      {
        cleaned: "Daft Punk - Get Lucky",
        artist: "Daft Punk",
        title: "Get Lucky",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("David Bowie – Space Oddity [4K Remastered]"),
      {
        cleaned: "David Bowie - Space Oddity",
        artist: "David Bowie",
        title: "Space Oddity",
      },
    );

    assert.deepEqual(
      cleanYouTubeTitle("Eminem - Without Me (Official Music Video) [HD]"),
      {
        cleaned: "Eminem - Without Me",
        artist: "Eminem",
        title: "Without Me",
      },
    );
  });

  it("handles standalone song names without artist separator", () => {
    assert.deepEqual(
      cleanYouTubeTitle("Bohemian Rhapsody (Official Audio)"),
      {
        cleaned: "Bohemian Rhapsody",
        artist: null,
        title: "Bohemian Rhapsody",
      },
    );
  });

  it("detects punctuation-only tokens", () => {
    assert.equal(isPunctuationOnly("-"), true);
    assert.equal(isPunctuationOnly("–"), true);
    assert.equal(isPunctuationOnly("|"), true);
    assert.equal(isPunctuationOnly("..."), true);
    assert.equal(isPunctuationOnly("Coldplay"), false);
    assert.equal(isPunctuationOnly("1975"), false);
    assert.equal(isPunctuationOnly("(Live)"), false);
  });

  it("sanitizes queries for search tokens", () => {
    assert.equal(
      sanitizeSearchQuery("Queen - Bohemian Rhapsody (Official Video)"),
      "Queen Bohemian Rhapsody",
    );
  });
});
