const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

globalThis.jsyaml = require("../js/vendor/js-yaml.min.js");
const Orbis = require("../js/orbis-core.js");
const sampleYaml = require("../js/sample-campaign.js");

const root = path.join(__dirname, "..");
const sampleFile = fs.readFileSync(path.join(root, "campaigns/salt-on-the-threshold.yaml"), "utf8");

function mustParse(text) {
  const parsed = Orbis.parseSource(text);
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.package;
}

function playSample() {
  const pkg = mustParse(sampleFile);
  const errors = Orbis.validate(pkg);
  assert.deepEqual(errors, [], errors.map(function (error) { return error.path + " " + error.message; }).join("\n"));
  const id = Orbis.identify(pkg);
  const made = Orbis.createSession(pkg, id, ["Ира", "Лев"]);
  assert.equal(made.ok, true, made.error);
  return made.state;
}

function ok(state, action) {
  const result = Orbis.act(state, action);
  assert.equal(result.ok, true, result.error);
  return result.state;
}

test("embedded sample matches the campaign file", function () {
  assert.equal(sampleYaml, sampleFile);
});

test("sample package is ready to play", function () {
  const pkg = mustParse(sampleFile);
  assert.equal(pkg.format, "orbis/1");
  assert.deepEqual(Orbis.validate(pkg), []);
  const again = Orbis.identify(JSON.parse(JSON.stringify(pkg)));
  const swapped = {
    scenarios: pkg.scenarios,
    campaign: pkg.campaign,
    format: pkg.format,
  };
  assert.equal(Orbis.identify(pkg).fingerprint, Orbis.identify(swapped).fingerprint);
  assert.equal(again.revision_id, "rev-" + again.fingerprint.slice(0, 8));
});

test("success carries the salt flag into the second scenario", function () {
  let state = playSample();
  state = ok(state, { type: "begin_scenario", scenario_id: "dry_pier" });
  const setup = Orbis.presentation(state);
  assert.equal(setup.kind, "setup");
  assert.match(setup.read_aloud, /пристань стоит в сухой грязи/);
  assert.match(setup.host_note, /Ира и Лев/);
  assert.match(setup.host_note, /2/);
  assert.ok(setup.placed.some(function (item) { return item.id === "customs_hall" && item.initial; }));

  state = ok(state, { type: "confirm_setup" });
  assert.equal(state.step, null);
  assert.equal(state.opening_done, false);

  const early = Orbis.act(state, { type: "marker", component: "bell_rope" });
  assert.equal(early.ok, false);

  state = ok(state, { type: "phase", phase: "opening" });
  assert.equal(state.step.id, "opening_bell");
  state = ok(state, { type: "choice", index: 0 });
  state = ok(state, { type: "marker", component: "bell_rope" });
  state = ok(state, { type: "choice", index: 0 });
  assert.ok(state.revealed.includes("pier_lamp"));
  assert.ok(state.banner.placed.some(function (item) { return item.id === "brine_figure"; }));

  state = ok(state, { type: "marker", component: "salt_bin" });
  state = ok(state, { type: "choice", index: 0 });
  state = ok(state, { type: "host_call", call: "lay_salt" });
  state = ok(state, { type: "choice", index: 0 });
  assert.ok(state.flags.includes("salt_on_the_threshold"));

  state = ok(state, { type: "marker", component: "pier_lamp" });
  assert.equal(Orbis.presentation(state).choices.length, 2);
  state = ok(state, { type: "choice", index: 0 });
  const ending = Orbis.presentation(state);
  assert.equal(ending.kind, "ending");
  assert.equal(ending.ending_kind, "success");
  assert.match(ending.read_aloud, /Фитиль берётся/);
  assert.ok(ending.removed.some(function (item) { return item.id === "brine_figure"; }));

  state = ok(state, { type: "record_ending" });
  assert.equal(state.mode, "between");
  assert.equal(state.next, "net_loft");
  assert.deepEqual(Orbis.activeFlags(state), ["salt_on_the_threshold"]);
  assert.ok(state.closed.includes("dry_pier"));

  const denied = Orbis.act(state, { type: "begin_scenario", scenario_id: "dry_pier" });
  assert.equal(denied.ok, false);

  state = ok(state, { type: "begin_scenario", scenario_id: "net_loft" });
  assert.ok(state.revealed.includes("stair_figure"));
  state = ok(state, { type: "confirm_setup" });
  const salt = Orbis.presentation(state);
  assert.equal(state.step.id, "salt_holds_stair");
  assert.match(salt.read_aloud, /вчерашняя соль/);
  state = ok(state, { type: "choice", index: 0 });
  assert.equal(state.revealed.includes("stair_figure"), false);

  const file = Orbis.exportSession(state);
  const loaded = Orbis.importSession(JSON.parse(JSON.stringify(file)));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.state.fingerprint, state.fingerprint);
  assert.ok(loaded.state.flags.includes("salt_on_the_threshold"));
  assert.equal(loaded.state.revealed.includes("stair_figure"), false);
  assert.equal(loaded.state.scenario_id, "net_loft");

  state = loaded.state;
  state = ok(state, { type: "phase", phase: "opening" });
  state = ok(state, { type: "choice", index: 0 });
  state = ok(state, { type: "marker", component: "nets" });
  state = ok(state, { type: "choice", index: 0 });
  assert.ok(state.revealed.includes("dry_hymn"));
  state = ok(state, { type: "host_call", call: "speak_hymn" });
  state = ok(state, { type: "choice", index: 0 });
  assert.equal(Orbis.presentation(state).ending_kind, "success");
  state = ok(state, { type: "record_ending" });
  assert.equal(state.mode, "over");
  assert.equal(state.next, "stop");
  assert.ok(state.flags.includes("salt_on_the_threshold"));
  assert.deepEqual(Orbis.availableScenarios(state), []);
});

test("a night without salt leaves the stair watched", function () {
  let state = playSample();
  state = ok(state, { type: "begin_scenario", scenario_id: "dry_pier" });
  state = ok(state, { type: "confirm_setup" });
  state = ok(state, { type: "phase", phase: "opening" });
  state = ok(state, { type: "choice", index: 0 });
  for (let i = 0; i < 3; i++) {
    state = ok(state, { type: "phase", phase: "pressure" });
    assert.equal(state.clock, i + 1);
    assert.equal(state.step.id, "tide_tick");
    assert.match(Orbis.presentation(state).read_aloud, new RegExp("Мокрый час — " + (i + 1)));
    assert.match(Orbis.presentation(state).read_aloud, /Ира и Лев/);
    state = ok(state, { type: "choice", index: 0 });
  }
  state = ok(state, { type: "phase", phase: "pressure" });
  assert.equal(state.clock, 4);
  assert.equal(state.step.id, "tide_full");
  const undone = ok(state, { type: "undo" });
  assert.equal(undone.clock, 3);
  assert.equal(undone.step, null);
  state = ok(state, { type: "choice", index: 0 });
  assert.equal(Orbis.presentation(state).ending_kind, "failure");
  state = ok(state, { type: "record_ending" });
  assert.equal(state.flags.includes("salt_on_the_threshold"), false);
  assert.equal(state.next, "net_loft");

  state = ok(state, { type: "begin_scenario", scenario_id: "net_loft" });
  state = ok(state, { type: "confirm_setup" });
  assert.equal(state.step, null);
  assert.ok(state.revealed.includes("stair_figure"));
  assert.equal(state.opening_done, false);
});

test("undo restores a snapshot inside the exported evening", function () {
  let state = playSample();
  state = ok(state, { type: "begin_scenario", scenario_id: "dry_pier" });
  state = ok(state, { type: "confirm_setup" });
  state = ok(state, { type: "phase", phase: "opening" });
  const file = Orbis.exportSession(state);
  const loaded = Orbis.importSession(file);
  assert.equal(loaded.ok, true, loaded.error);
  const back = ok(loaded.state, { type: "undo" });
  assert.equal(back.opening_done, false);
  assert.equal(back.step, null);
});

test("silent events apply and a closed loop stops", function () {
  const pkg = minimal();
  pkg.scenarios[0].events.unshift({
    id: "quiet",
    when: { on: "phase", phase: "opening" },
    read_aloud: "",
    host_note: "",
    effects: [{ add_clock: 1 }, { go: "open" }],
  });
  assert.deepEqual(Orbis.validate(pkg), []);
  const id = Orbis.identify(pkg);
  let state = Orbis.createSession(pkg, id, ["Нора"]).state;
  state = ok(state, { type: "begin_scenario", scenario_id: "a" });
  state = ok(state, { type: "confirm_setup" });
  state = ok(state, { type: "phase", phase: "opening" });
  assert.equal(state.clock, 1);
  assert.equal(state.step.id, "open");
});

test("validation speaks plainly about a broken package", function () {
  const pkg = minimal();
  pkg.vibe = true;
  pkg.campaign.pitch = "Смотри https://example.com/secret";
  pkg.scenarios[0].events[0].read_aloud = "Сделай {foo}";
  pkg.scenarios[0].events[0].choices[0].effects.push({ go: "missing" });
  pkg.scenarios[0].events[0].choices[0].effects.push({ roll: 2 });
  const lost = pkg.scenarios[0].endings.pop();
  assert.ok(lost);
  const messages = Orbis.validate(pkg).map(function (error) { return error.message; }).join("\n");
  assert.match(messages, /Неизвестный ключ «vibe»/);
  assert.match(messages, /адреса сети/);
  assert.match(messages, /подстановка не из списка/);
  assert.match(messages, /событие «missing»/);
  assert.match(messages, /Команда «roll»/);
  assert.match(messages, /нет финала-провала/);

  const loop = minimal();
  loop.scenarios[0].events.push({
    id: "loop",
    when: { on: "host_calls", call: "loop", label: "Круг" },
    read_aloud: "",
    host_note: "",
    effects: [{ go: "loop" }],
  });
  const loopText = Orbis.validate(loop).map(function (error) { return error.message; }).join("\n");
  assert.match(loopText, /ходят по кругу/);

  const orphan = minimal();
  orphan.campaign.flags.push("ghost");
  orphan.campaign.scenarios.push("spare_one");
  orphan.scenarios.push(JSON.parse(JSON.stringify(orphan.scenarios[0])));
  orphan.scenarios[1].id = "spare_one";
  orphan.scenarios[1].title = "Запас";
  let orphanText = Orbis.validate(orphan).map(function (error) { return error.message; }).join("\n");
  assert.match(orphanText, /Флаг «ghost»/);
  assert.match(orphanText, /ниоткуда не открывается/);
  orphan.scenarios[1].spare = true;
  orphan.campaign.flags = ["known"];
  orphanText = Orbis.validate(orphan).map(function (error) { return error.message; }).join("\n");
  assert.equal(orphanText, "");
});

test("revision and session files refuse a mismatch", function () {
  const pkg = mustParse(sampleFile);
  const sealed = Orbis.seal(pkg, "2026-11-18T00:00:00.000Z");
  assert.equal(sealed.ok, true);
  const opened = Orbis.openRevision(sealed.revision);
  assert.equal(opened.ok, true);
  assert.equal(Orbis.openRevision(pkg).ok, false);
  const tampered = JSON.parse(JSON.stringify(sealed.revision));
  tampered.fingerprint = "0000000000000000";
  const bad = Orbis.openRevision(tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Отпечаток/);

  const state = playSample();
  const file = Orbis.exportSession(state);
  file.fingerprint = "0000000000000000";
  const loaded = Orbis.importSession(file);
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /Отпечаток/);
});

test("the second scenario cannot be opened before the first night", function () {
  const state = playSample();
  const jumped = Orbis.act(state, { type: "begin_scenario", scenario_id: "net_loft" });
  assert.equal(jumped.ok, false);
});

function minimal() {
  return {
    format: "orbis/1",
    campaign: {
      id: "c",
      title: "T",
      pitch: "P",
      flags: ["known"],
      scenarios: ["a"],
      start: "a",
    },
    scenarios: [{
      id: "a",
      title: "A",
      investigators: { min: 1, max: 2 },
      setup: { read_aloud: "Hello", host_note: "Note", present: ["hall"] },
      clock: { name: "Hour", start: 0, limit: 2 },
      components: [
        { id: "hall", kind: "room", label: "Hall", host_note: "", at: null },
      ],
      events: [
        {
          id: "open",
          when: { on: "phase", phase: "opening" },
          read_aloud: "Open",
          host_note: "",
          choices: [{ label: "Ok", effects: [{ set_flag: "known" }, { end: "win" }] }],
        },
        {
          id: "lose",
          when: { on: "clock_at", value: 2 },
          read_aloud: "Lose",
          host_note: "",
          choices: [{ label: "Fall", effects: [{ end: "fail" }] }],
        },
      ],
      endings: [
        { id: "win", kind: "success", when: { on: "event", event: "open" }, read_aloud: "Won", host_note: "", set_flags: ["known"], next: "stop" },
        { id: "fail", kind: "failure", when: { on: "event", event: "lose" }, read_aloud: "Lost", host_note: "", set_flags: [], next: "stop" },
      ],
    }],
  };
}
