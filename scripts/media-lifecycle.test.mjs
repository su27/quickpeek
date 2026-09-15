import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediaSession } from "../src/media-lifecycle.ts";

class Media extends EventTarget {
  src = "";
  plays = 0;
  pauses = 0;
  loads = 0;
  load() { this.loads++; }
  pause() { this.pauses++; }
  play() { this.plays++; return new Promise(() => {}); }
  removeAttribute() { this.src = ""; }
  querySelectorAll() { return []; }
}
const fixture = (timeout = 100) => {
  const media = new Media();
  const cancellation = new AbortController();
  const errors = [];
  const session = createMediaSession(media, cancellation.signal, (error) => errors.push(error), timeout);
  return { media, cancellation, errors, session };
};

test("metadata is enough to commit; playback starts only after showing", async () => {
  const { media, session } = fixture();
  const loaded = session.load("fixture.mov");
  media.dispatchEvent(new Event("loadedmetadata"));
  await loaded;
  assert.equal(media.plays, 0);
  assert.equal(session.start(), undefined);
  assert.equal(media.plays, 1);
  session.dispose();
});
test("closing during metadata loading rejects and releases decoder immediately", async () => {
  const { media, cancellation, session } = fixture();
  const rejected = assert.rejects(session.load("fixture.mov"), { name: "AbortError" });
  cancellation.abort();
  await rejected;
  assert.equal(media.src, "");
  assert.equal(media.pauses, 1);
  assert.equal(session.disposed, true);
  session.dispose();
  assert.equal(media.pauses, 1);
});
test("missing metadata and unsupported codecs cannot hold the queue indefinitely", async () => {
  const { media, session } = fixture(10);
  await assert.rejects(session.load("broken.mov"), /timed out/);
  assert.equal(media.src, "");
});
test("media errors before metadata reject without waiting for timeout", async () => {
  const { media, session } = fixture();
  const rejected = assert.rejects(session.load("broken.mov"), /Playback failed/);
  media.dispatchEvent(new Event("error"));
  await rejected;
  assert.equal(session.disposed, true);
});
test("pending play is bounded and freed; it never blocks the caller", async () => {
  const { media, session, errors } = fixture(10);
  const loaded = session.load("fixture.mov");
  media.dispatchEvent(new Event("loadedmetadata"));
  await loaded;
  session.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.disposed, true);
  assert.equal(media.src, "");
  assert.equal(errors.length, 1);
});
test("cancelled old session cannot stop the next file", async () => {
  const first = fixture();
  const second = fixture();
  const cancelled = assert.rejects(first.session.load("old.mov"), { name: "AbortError" });
  first.cancellation.abort();
  await cancelled;
  const loaded = second.session.load("new.mov");
  second.media.dispatchEvent(new Event("loadedmetadata"));
  await loaded;
  first.session.dispose();
  assert.equal(second.media.src, "new.mov");
  second.session.dispose();
});

test("rapid MOV/MOV/MP3 selection cancels every pending decoder before the last starts", async () => {
  const sessions = [];
  for (const name of ["first.mov", "second.mov", "one.mp3", "two.mp3", "last.mp3"]) {
    const previous = sessions.at(-1);
    if (previous) {
      const rejected = assert.rejects(previous.loaded, { name: "AbortError" });
      previous.cancellation.abort();
      await rejected;
    }
    const current = fixture();
    current.loaded = current.session.load(name);
    sessions.push(current);
  }
  const last = sessions.at(-1);
  last.media.dispatchEvent(new Event("loadedmetadata"));
  await last.loaded;
  assert.ok(sessions.slice(0,-1).every(s=>s.session.disposed && s.media.src === ""));
  assert.equal(last.media.src,"last.mp3");
  last.session.dispose();
});
