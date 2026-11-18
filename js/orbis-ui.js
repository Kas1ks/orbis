/* Keeper page. One tab, two doors. No fetch, no model, no player client. */
(function () {
  const LIB = "orbis.revisions.v1";
  const SESSION = "orbis.session.v1";
  const PHASE_LABEL = {
    opening: "Открытие",
    actions_done: "Сыщики закончили",
    pressure: "Давление",
    creatures: "Существа",
  };
  const KIND_LABEL = { room: "комната", marker: "жетон", creature: "существо", object: "предмет" };
  const ENDING_LABEL = { success: "Успех", failure: "Провал", other: "Иначе" };

  const ui = {
    screen: "home",
    intake: { text: "", pkg: null, errors: [], parseError: "", dirty: false, view: "form", rehearseId: null, status: "" },
    library: [],
    session: null,
    picked: null,
    names: ["", ""],
    paused: false,
    confirmEnd: false,
    playError: "",
    focusPath: null,
    focusPos: null,
    openScenarios: {},
  };

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    const list = Array.isArray(children) ? children : children == null ? [] : [children];
    Object.keys(attrs || {}).forEach(function (key) {
      const value = attrs[key];
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    list.forEach(function (child) {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function button(action, label, arg, className) {
    const attrs = { type: "button", "data-action": action, class: className || "" };
    if (arg != null) attrs["data-arg"] = String(arg);
    return h("button", attrs, label);
  }

  function paragraphs(text) {
    const parts = String(text || "").split(/\n+/).map(function (part) { return part.trim(); }).filter(Boolean);
    if (!parts.length) return [h("p", {}, "")];
    return parts.map(function (part) { return h("p", {}, part); });
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) { /* the file export is the copy that survives */ }
  }

  function loadLibrary() {
    try {
      const raw = JSON.parse(storageGet(LIB) || "[]");
      ui.library = (Array.isArray(raw) ? raw : []).filter(function (item) {
        return item && item.package && item.fingerprint && Orbis.validate(item.package).length === 0 && Orbis.identify(item.package).fingerprint === item.fingerprint;
      });
    } catch (err) {
      ui.library = [];
    }
  }

  function saveLibrary() {
    storageSet(LIB, JSON.stringify(ui.library));
  }

  function rememberRevision(revision) {
    ui.library = [{
      revision_id: revision.revision_id,
      fingerprint: revision.fingerprint,
      saved_at: revision.saved_at,
      title: revision.package.campaign.title,
      package: revision.package,
    }].concat(ui.library.filter(function (item) { return item.fingerprint !== revision.fingerprint; })).slice(0, 20);
    ui.picked = ui.library[0];
    saveLibrary();
  }

  function persistSession() {
    if (!ui.session) storageSet(SESSION, null);
    else storageSet(SESSION, JSON.stringify(Orbis.exportSession(ui.session)));
  }

  function download(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1500);
  }

  function fileButton(label, accept, done) {
    const wrap = h("span", { class: "file-btn" });
    const input = h("input", { type: "file", accept: accept });
    input.addEventListener("change", function () {
      const picked = input.files && input.files[0];
      if (picked) readFile(picked, done);
    });
    const trigger = h("button", { type: "button" }, label);
    trigger.addEventListener("click", function () { input.click(); });
    wrap.append(trigger, input);
    return wrap;
  }

  function readFile(file, done) {
    const reader = new FileReader();
    reader.onload = function () { done(String(reader.result || "")); };
    reader.readAsText(file);
  }

  function getPath(obj, path) {
    return String(path).split("/").reduce(function (cursor, part) {
      return cursor == null ? undefined : cursor[part];
    }, obj);
  }

  function setPath(obj, path, value) {
    const parts = String(path).split("/");
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]];
    cursor[parts[parts.length - 1]] = value;
  }

  function renameFlag(pkg, index, value) {
    const old = pkg.campaign.flags[index];
    pkg.campaign.flags[index] = value;
    if (!old || old === value) return;
    (pkg.scenarios || []).forEach(function (sc) {
      (sc.events || []).forEach(function (event) {
        if (event.when && event.when.flag === old) event.when.flag = value;
        [event.effects || []].concat((event.choices || []).map(function (choice) { return choice.effects || []; })).forEach(function (list) {
          list.forEach(function (eff) {
            if (eff.set_flag === old) eff.set_flag = value;
            if (eff.clear_flag === old) eff.clear_flag = value;
          });
        });
      });
      (sc.endings || []).forEach(function (ending) {
        if (ending.when && ending.when.flag === old) ending.when.flag = value;
        if (Array.isArray(ending.set_flags)) {
          ending.set_flags = ending.set_flags.map(function (flag) { return flag === old ? value : flag; });
        }
      });
    });
  }

  function refreshIntake() {
    if (!ui.intake.pkg) {
      ui.intake.errors = [];
      return;
    }
    ui.intake.errors = Orbis.validate(ui.intake.pkg);
    ui.intake.status = "";
  }

  function adoptText(text) {
    ui.intake.text = text;
    ui.intake.dirty = false;
    ui.intake.status = "";
    const parsed = Orbis.parseSource(text);
    if (!parsed.ok) {
      ui.intake.pkg = null;
      ui.intake.errors = [];
      ui.intake.parseError = parsed.error;
      return;
    }
    ui.intake.pkg = parsed.package;
    ui.intake.parseError = "";
    ui.intake.errors = Orbis.validate(parsed.package);
    const start = parsed.package.campaign && parsed.package.campaign.start;
    if (start) ui.intake.rehearseId = start;
  }

  function scenarioOptions(pkg, withStop) {
    const options = (pkg.scenarios || []).filter(function (sc) { return sc && sc.id; }).map(function (sc) {
      return { value: sc.id, label: (sc.title || sc.id) + " · " + sc.id };
    });
    if (withStop) options.push({ value: "stop", label: "Конец кампании" });
    return options;
  }

  function componentOptions(sc, kind) {
    return (sc.components || []).filter(function (comp) { return !kind || comp.kind === kind; }).map(function (comp) {
      return { value: comp.id, label: comp.label + " · " + (KIND_LABEL[comp.kind] || comp.kind) };
    });
  }

  function eventOptions(sc) {
    return (sc.events || []).map(function (event) { return { value: event.id, label: event.id }; });
  }

  function endingOptions(sc) {
    return (sc.endings || []).map(function (ending) { return { value: ending.id, label: ending.id }; });
  }

  function flagOptions(pkg) {
    return (pkg.campaign.flags || []).map(function (flag) { return { value: flag, label: flag }; });
  }

  function field(label, control) {
    const wrap = h("label", { class: "field" }, [h("span", { class: "field-label" }, label), control]);
    return wrap;
  }

  function textControl(path, value, multiline) {
    const control = multiline ? h("textarea", { "data-path": path, rows: "4" }) : h("input", { type: "text", "data-path": path });
    control.value = value == null ? "" : String(value);
    return control;
  }

  function numberControl(path, value) {
    const control = h("input", { type: "number", "data-path": path, "data-kind": "int" });
    control.value = value == null ? "" : String(value);
    return control;
  }

  function selectControl(path, value, options, nil) {
    const select = h("select", { "data-path": path });
    if (nil) select.setAttribute("data-nil", "null");
    const list = options.slice();
    const current = value == null ? "" : String(value);
    if (!list.some(function (option) { return option.value === current; })) {
      list.unshift({ value: current, label: current ? current + " · нет в пакете" : "—" });
    }
    list.forEach(function (option) {
      const node = h("option", { value: option.value }, option.label);
      select.append(node);
    });
    select.value = current;
    return select;
  }

  function whenLine(when) {
    if (!when || !when.on) return "Повод не задан";
    const names = {
      session_start: "Старт партии",
      phase: "Фаза",
      marker_used: "Жетон использован",
      creature_down: "Существо снято",
      clock_at: "Часы дошли до порога",
      flag_is: "В тетради стоит флаг",
      host_calls: "Именной такт",
      event: "Событие закрывает финал",
    };
    return "Повод: " + (names[when.on] || when.on);
  }

  function effectFields(effects, path, sc, pkg) {
    const box = h("div", { class: "effects" });
    if (!effects || !effects.length) {
      box.append(h("p", { class: "hint" }, "Команд нет."));
      return box;
    }
    effects.forEach(function (eff, index) {
      if (!eff || typeof eff !== "object") return;
      const key = Object.keys(eff)[0];
      const at = path + "/" + index + "/" + key;
      if (key === "go") box.append(field("Переход к событию", selectControl(at, eff.go, eventOptions(sc))));
      else if (key === "end") box.append(field("Финал", selectControl(at, eff.end, endingOptions(sc))));
      else if (key === "reveal" || key === "hide") box.append(field(key === "reveal" ? "Положить" : "Убрать", selectControl(at, eff[key], componentOptions(sc))));
      else if (key === "set_flag" || key === "clear_flag") box.append(field(key === "set_flag" ? "Поставить флаг" : "Снять флаг", selectControl(at, eff[key], flagOptions(pkg))));
      else if (key === "add_clock") box.append(field("Сдвинуть часы", numberControl(at, eff.add_clock)));
      else box.append(h("p", { class: "hint" }, "Команда «" + key + "» не из списка."));
    });
    return box;
  }

  function whenFields(when, path, sc, pkg) {
    const box = h("div", {}, h("p", { class: "when" }, whenLine(when)));
    if (!when) return box;
    if (when.on === "phase") {
      box.append(field("Фаза", selectControl(path + "/phase", when.phase, Orbis.PHASES.map(function (phase) {
        return { value: phase, label: PHASE_LABEL[phase] };
      }))));
    }
    if (when.on === "marker_used") box.append(field("Жетон", selectControl(path + "/component", when.component, componentOptions(sc, "marker"))));
    if (when.on === "creature_down") box.append(field("Существо", selectControl(path + "/component", when.component, componentOptions(sc, "creature"))));
    if (when.on === "clock_at") box.append(field("Порог", numberControl(path + "/value", when.value)));
    if (when.on === "flag_is") box.append(field("Флаг", selectControl(path + "/flag", when.flag, flagOptions(pkg))));
    if (when.on === "host_calls") {
      box.append(field("Имя такта", textControl(path + "/call", when.call)));
      box.append(field("Подпись кнопки", textControl(path + "/label", when.label)));
    }
    if (when.on === "event") box.append(field("Событие", selectControl(path + "/event", when.event, eventOptions(sc))));
    return box;
  }

  function presentField(sc, index) {
    const path = "scenarios/" + index + "/setup/present";
    const selected = new Set(sc.setup.present || []);
    const wrap = h("fieldset", { class: "flags-edit" }, h("legend", {}, "Уже на столе с первой минуты"));
    (sc.components || []).forEach(function (comp) {
      const label = h("label", { class: "check" });
      const input = h("input", { type: "checkbox", "data-path": path, "data-present": comp.id });
      input.checked = selected.has(comp.id);
      label.append(input, document.createTextNode(" " + comp.label));
      wrap.append(label);
    });
    return wrap;
  }

  function flagSetField(path, selected) {
    const wrap = h("fieldset", { class: "flags-edit" }, h("legend", {}, "Флаги, которые финал дописывает"));
    (ui.intake.pkg.campaign.flags || []).forEach(function (flag) {
      const label = h("label", { class: "check" });
      const input = h("input", { type: "checkbox", "data-path": path, "data-flag": flag });
      input.checked = (selected || []).includes(flag);
      label.append(input, document.createTextNode(" " + flag));
      wrap.append(label);
    });
    return wrap;
  }

  function campaignForm(pkg) {
    const box = h("section", { class: "campaign-box" });
    box.append(h("h2", { class: "block-title" }, "Кампания"));
    box.append(field("Название", textControl("campaign/title", pkg.campaign.title)));
    box.append(field("Питч ведущему", textControl("campaign/pitch", pkg.campaign.pitch, true)));
    box.append(field("Старт", selectControl("campaign/start", pkg.campaign.start, scenarioOptions(pkg))));
    (pkg.campaign.flags || []).forEach(function (flag, index) {
      box.append(field("Флаг " + (index + 1), textControl("flag:" + index, flag)));
    });
    box.append(h("p", { class: "hint" }, "Имя флага меняется и в командах. Фразы для стола сами не переписываются. Новую сцену это поле не создаёт."));
    return box;
  }

  function scenarioForm(sc, index, pkg) {
    const base = "scenarios/" + index;
    const details = h("details", { class: "scenario" });
    details.open = ui.openScenarios[index] === undefined ? index === 0 : !!ui.openScenarios[index];
    details.addEventListener("toggle", function () { ui.openScenarios[index] = details.open; });
    details.append(h("summary", {}, sc.title || sc.id || "Сценарий"));
    if (!sc.setup || !sc.clock || !sc.investigators || !Array.isArray(sc.components) || !Array.isArray(sc.events) || !Array.isArray(sc.endings)) {
      details.append(h("p", { class: "hint" }, "В сценарии не хватает обстановки, часов, компонентов или событий. Ошибка выше; поправьте текст и разберите пакет снова."));
      return details;
    }
    details.append(field("Название", textControl(base + "/title", sc.title)));
    details.append(field("Зачитать в начале", textControl(base + "/setup/read_aloud", sc.setup && sc.setup.read_aloud, true)));
    details.append(field("Пометка к началу", textControl(base + "/setup/host_note", sc.setup && sc.setup.host_note, true)));
    details.append(presentField(sc, index));
    details.append(field("Имя часов", textControl(base + "/clock/name", sc.clock && sc.clock.name)));
    details.append(field("Часы в начале", numberControl(base + "/clock/start", sc.clock && sc.clock.start)));
    details.append(field("Предел часов", numberControl(base + "/clock/limit", sc.clock && sc.clock.limit)));
    details.append(field("Сыщиков от", numberControl(base + "/investigators/min", sc.investigators && sc.investigators.min)));
    details.append(field("Сыщиков до", numberControl(base + "/investigators/max", sc.investigators && sc.investigators.max)));
    (sc.components || []).forEach(function (comp, ci) {
      const cp = base + "/components/" + ci;
      const block = h("div", { class: "campaign-box" });
      block.append(h("p", { class: "eyebrow" }, (KIND_LABEL[comp.kind] || "компонент") + " · " + comp.id));
      block.append(field("Подпись для стола", textControl(cp + "/label", comp.label)));
      block.append(field("Пометка", textControl(cp + "/host_note", comp.host_note, true)));
      if (comp.kind !== "room") {
        const rooms = [{ value: "", label: "ни в какой комнате" }].concat(componentOptions(sc, "room"));
        block.append(field("Где лежит", selectControl(cp + "/at", comp.at, rooms, true)));
      }
      details.append(block);
    });
    (sc.events || []).forEach(function (event, ei) {
      const ep = base + "/events/" + ei;
      const block = h("div", { class: "campaign-box" });
      block.append(h("p", { class: "eyebrow" }, "Событие · " + event.id));
      block.append(whenFields(event.when, ep + "/when", sc, pkg));
      block.append(field("Зачитать", textControl(ep + "/read_aloud", event.read_aloud, true)));
      block.append(field("Пометка ведущему", textControl(ep + "/host_note", event.host_note, true)));
      if (event.choices && event.choices.length) {
        event.choices.forEach(function (choice, ci) {
          const cp = ep + "/choices/" + ci;
          block.append(field("Выбор " + (ci + 1), textControl(cp + "/label", choice.label)));
          block.append(effectFields(choice.effects, cp + "/effects", sc, pkg));
        });
      } else block.append(effectFields(event.effects, ep + "/effects", sc, pkg));
      details.append(block);
    });
    (sc.endings || []).forEach(function (ending, ei) {
      const ep = base + "/endings/" + ei;
      const block = h("div", { class: "campaign-box" });
      block.append(h("p", { class: "eyebrow" }, "Финал · " + (ENDING_LABEL[ending.kind] || ending.kind) + " · " + ending.id));
      block.append(whenFields(ending.when, ep + "/when", sc, pkg));
      block.append(field("Зачитать", textControl(ep + "/read_aloud", ending.read_aloud, true)));
      block.append(field("Пометка ведущему", textControl(ep + "/host_note", ending.host_note, true)));
      block.append(field("Дальше", selectControl(ep + "/next", ending.next, scenarioOptions(pkg, true))));
      block.append(flagSetField(ep + "/set_flags", ending.set_flags));
      details.append(block);
    });
    return details;
  }

  function errorBox() {
    const box = h("div", { class: "errors", "data-field": "errors" });
    if (ui.intake.parseError) box.append(h("p", {}, ui.intake.parseError));
    ui.intake.errors.slice(0, 40).forEach(function (error) {
      box.append(h("p", {}, [h("span", { class: "path" }, error.path), " " + error.message]));
    });
    if (ui.intake.errors.length > 40) box.append(h("p", {}, "И ещё " + (ui.intake.errors.length - 40) + "."));
    if (!ui.intake.parseError && ui.intake.pkg && !ui.intake.errors.length) {
      box.append(h("p", { class: "ready", "data-field": "ready" }, "Пакет можно вести. Отметьте ревизию — партия увидит только её."));
    }
    if (!ui.intake.parseError && !ui.intake.pkg && !ui.intake.text) box.append(h("p", {}, "Откройте файл, вставьте пакет или возьмите пример."));
    return box;
  }

  function rehearse(pkg) {
    const ids = (pkg.scenarios || []).map(function (sc) { return sc.id; });
    const current = ids.includes(ui.intake.rehearseId) ? ui.intake.rehearseId : (pkg.campaign && pkg.campaign.start);
    const sc = Orbis.scenarioById(pkg, current);
    const page = h("div");
    page.append(h("p", { class: "hint" }, "Репетиция без стола: открытие, один круг, финалы и переход. Это чтение, не партия. Подстановки {names}, {investigators}, {clock}, {clock_name} и {component:id} встанут вечером."));
    page.append(field("Сценарий", selectControl("rehearse", current, (pkg.scenarios || []).map(function (item) {
      return { value: item.id, label: item.title };
    }))));
    if (!sc) return page;
    function block(title, items) {
      const section = h("section", { class: "rehearse-block" }, h("h3", {}, title));
      if (!items.length) section.append(h("p", { class: "hint" }, "В пакете на это нет текста."));
      items.forEach(function (item) {
        section.append(h("p", { class: "eyebrow" }, item.kicker));
        paragraphs(item.read || "Немой шаг. Стол ничего не слышит.").forEach(function (para) {
          para.className = "read";
          section.append(para);
        });
        if (item.note) paragraphs(item.note).forEach(function (para) { section.append(para); });
      });
      return section;
    }
    const events = sc.events || [];
    const ofPhase = function (phase) {
      return events.filter(function (event) { return event.when && event.when.on === "phase" && event.when.phase === phase; });
    };
    page.append(block("Открытие", [{ kicker: "Обстановка", read: sc.setup.read_aloud, note: sc.setup.host_note }].concat(ofPhase("opening").map(function (event) {
      return { kicker: event.id, read: event.read_aloud, note: event.host_note };
    }))));
    page.append(block("Один круг", ["actions_done", "pressure", "creatures"].reduce(function (list, phase) {
      return list.concat(ofPhase(phase).map(function (event) {
        return { kicker: PHASE_LABEL[phase], read: event.read_aloud, note: event.host_note };
      }));
    }, [])));
    page.append(block("Финалы", (sc.endings || []).map(function (ending) {
      const next = ending.next === "stop" ? "кампания закрывается" : ((Orbis.scenarioById(pkg, ending.next) || {}).title || ending.next);
      return { kicker: (ENDING_LABEL[ending.kind] || ending.kind) + " → " + next, read: ending.read_aloud, note: ending.host_note };
    })));
    return page;
  }

  function intakeScreen() {
    const page = h("main", { class: "intake" });
    const sheet = h("div", { class: "intake-sheet" });
    sheet.append(button("home", "К дверям", null, "text-btn"));
    sheet.append(h("div", { class: "seal" }));
    sheet.append(h("p", { class: "wordmark" }, "Orbis"));
    sheet.append(h("h1", {}, "Приём данных"));
    sheet.append(h("p", { class: "lede" }, "Сюжет сюда приносят уже написанным. Здесь его проверяют, правят лежащую фразу, связь или флаг и отмечают ревизию. Новую сцену страница не выдумывает."));
    const area = h("textarea", { "data-path": "source", rows: "10", placeholder: "format: orbis/1" });
    area.value = ui.intake.text;
    sheet.append(field("Файл или вставка", area));
    const tools = h("div", { class: "row" });
    tools.append(
      fileButton("Открыть файл", ".json,.yaml,.yml,.txt,application/json,text/plain", function (text) {
        ui.focusPath = null;
        adoptText(text);
        render();
      }),
      button("sample", "Пример: Соль на пороге"),
      button("parse", "Разобрать текст"),
      button("download-package", "Скачать пакет")
    );
    sheet.append(tools);
    if (ui.intake.dirty) sheet.append(h("p", { class: "hint" }, "Окно текста отстаёт от полей. «Разобрать текст» соберёт пакет заново и снимет эти правки."));
    sheet.append(errorBox());
    const ready = ui.intake.pkg && !ui.intake.errors.length && !ui.intake.parseError;
    const actions = h("div", { class: "row" });
    const seal = button("seal", "Отметить ревизию готовой", null, "primary");
    seal.disabled = !ready;
    actions.append(seal);
    if (ready) {
      actions.append(button(ui.intake.view === "rehearse" ? "show-form" : "show-rehearse", ui.intake.view === "rehearse" ? "К полям" : "Репетиция"));
      if (ui.intake.status) actions.append(button("play-sealed", "Открыть партию этой ревизии", null, "primary"));
    }
    sheet.append(actions);
    if (ui.intake.status) sheet.append(h("p", { "data-field": "status" }, ui.intake.status));
    if (ui.intake.pkg && ui.intake.pkg.campaign && Array.isArray(ui.intake.pkg.scenarios)) {
      if (ui.intake.view === "rehearse" && ready) sheet.append(rehearse(ui.intake.pkg));
      else {
        sheet.append(campaignForm(ui.intake.pkg));
        ui.intake.pkg.scenarios.forEach(function (sc, index) {
          if (sc && typeof sc === "object") sheet.append(scenarioForm(sc, index, ui.intake.pkg));
        });
      }
    }
    page.append(sheet);
    return page;
  }

  function namesEditor(hint) {
    const box = h("div", { class: "names" });
    box.append(h("p", { class: "eyebrow" }, "Сыщики"));
    if (hint) box.append(h("p", { class: "hint" }, hint));
    const count = h("input", { type: "number", min: "1", max: "8", "data-path": "count" });
    count.value = String(ui.names.length || 1);
    box.append(field("Сколько за столом", count));
    ui.names.forEach(function (name, index) {
      const input = h("input", { type: "text", "data-path": "name/" + index, placeholder: "Имя" });
      input.value = name;
      box.append(field("Имя " + (index + 1), input));
    });
    return box;
  }

  function gateScreen() {
    const page = h("main", { class: "gate" });
    const sheet = h("div", { class: "gate-sheet" });
    sheet.append(button("home", "К дверям", null, "text-btn"));
    sheet.append(h("div", { class: "seal" }));
    sheet.append(h("p", { class: "wordmark" }, "Orbis"));
    sheet.append(h("h1", {}, "Партия"));
    sheet.append(h("p", { class: "lede" }, "Откройте готовую ревизию. Вечер идёт по ней и не пишет новый текст."));
    if (!ui.library.length) sheet.append(h("p", {}, "В этой вкладке ещё нет ревизий. Отметьте пакет в приёме данных или откройте файл ревизии."));
    ui.library.forEach(function (item) {
      const picked = ui.picked && ui.picked.fingerprint === item.fingerprint;
      const choice = button("pick", (picked ? "Выбрана · " : "") + item.title + " · " + item.revision_id, item.fingerprint, picked ? "primary" : "");
      sheet.append(choice);
    });
    const files = h("div", { class: "row" });
    files.append(
      fileButton("Открыть ревизию", ".json,application/json,text/plain", openMaybeRevision),
      fileButton("Открыть снимок", ".json,application/json,text/plain", openMaybeSession)
    );
    sheet.append(files);
    if (ui.picked) {
      const id = Orbis.identify(ui.picked.package);
      const next = Orbis.scenarioById(ui.picked.package, ui.picked.package.campaign.start);
      sheet.append(h("h2", {}, ui.picked.package.campaign.title));
      sheet.append(h("p", { class: "hint" }, ui.picked.package.campaign.pitch));
      sheet.append(h("p", { class: "mono", "data-field": "fingerprint" }, id.fingerprint));
      sheet.append(h("p", { "data-field": "next" }, "Первый сценарий: " + (next ? next.title : ui.picked.package.campaign.start)));
      sheet.append(namesEditor(next ? "В сценарии от " + next.investigators.min + " до " + next.investigators.max + "." : ""));
      sheet.append(button("begin-fresh", "Начать «" + (next ? next.title : "") + "»", ui.picked.package.campaign.start, "primary"));
    }
    if (ui.playError) sheet.append(h("p", { class: "play-error", "data-field": "play-error" }, ui.playError));
    page.append(sheet);
    return page;
  }

  function openMaybeRevision(text) {
    const parsed = Orbis.parseSource(text);
    ui.focusPath = null;
    if (!parsed.ok) {
      ui.playError = parsed.error;
      render();
      return;
    }
    const opened = Orbis.openRevision(parsed.package);
    if (!opened.ok) {
      ui.playError = opened.error;
      render();
      return;
    }
    rememberRevision(opened.revision);
    ui.playError = "";
    render();
  }

  function openMaybeSession(text) {
    const parsed = Orbis.parseSource(text);
    ui.focusPath = null;
    if (!parsed.ok) {
      ui.playError = parsed.error;
      render();
      return;
    }
    const opened = Orbis.importSession(parsed.package);
    if (!opened.ok) {
      ui.playError = opened.error;
      render();
      return;
    }
    ui.session = opened.state;
    ui.names = opened.state.names.slice();
    ui.paused = false;
    ui.confirmEnd = false;
    ui.playError = "";
    ui.screen = "play";
    persistSession();
    render();
  }

  function pieceList(view) {
    const items = [];
    (view.placed || []).forEach(function (piece) {
      items.push({ verb: piece.initial ? "На столе" : "Положить", piece: piece });
    });
    (view.removed || []).forEach(function (piece) {
      items.push({ verb: "Убрать", piece: piece });
    });
    if (!items.length) return h("div");
    const list = h("ul", { class: "pieces", "data-field": "pieces" });
    items.forEach(function (item) {
      list.append(h("li", {}, [
        h("span", { class: "verb" }, item.verb),
        h("span", {}, [item.piece.label, " ", h("span", { class: "kind" }, KIND_LABEL[item.piece.kind] || "")]),
      ]));
    });
    return list;
  }

  function readBlock(text) {
    const block = h("div", { class: "read", "data-field": "read-aloud", tabindex: "-1" });
    paragraphs(text).forEach(function (para) { block.append(para); });
    return block;
  }

  function playSheet(state) {
    const view = Orbis.presentation(state);
    const sc = state.scenario_id ? Orbis.scenarioById(state.package, state.scenario_id) : null;
    const sheet = h("section", { class: ui.paused ? "sheet dim" : "sheet", "aria-live": "polite" });
    if (state.mode === "between" || state.mode === "over") {
      const closed = Orbis.scenarioById(state.package, state.closed[state.closed.length - 1]);
      sheet.append(h("p", { class: "kicker" }, state.mode === "over" ? "Кампания закрыта" : "Сценарий закрыт"));
      sheet.append(h("h1", { "data-field": "scenario" }, closed ? closed.title : state.package.campaign.title));
      sheet.append(h("p", { class: "quiet" }, state.mode === "over"
        ? "Тетрадь записана. Нового сценария в этой ревизии нет."
        : "Текст следующего сценария не открыт. Он начнётся отдельным вечером, из той же ревизии."));
      return sheet;
    }
    if (sc) sheet.append(h("p", { class: "evening", "data-field": "scenario" }, sc.title));
    if (view.kind === "setup" || view.kind === "event" || view.kind === "ending") {
      sheet.append(h("p", { class: "kicker" }, view.kind === "setup" ? "Обстановка" : "Зачитать"));
      sheet.append(readBlock(view.read_aloud));
      sheet.append(pieceList(view));
    } else if (view.kind === "empty") {
      sheet.append(h("p", { class: "quiet", "data-field": "read-aloud", tabindex: "-1" }, "На эту фазу пакет ничего не говорит вслух."));
      sheet.append(pieceList(view));
    } else if (view.kind === "fault") {
      sheet.append(h("p", { class: "quiet", "data-field": "read-aloud", tabindex: "-1" }, "Шаг остановился. Справа — почему. Отмена вернёт прошлый снимок, не новый текст."));
    } else {
      sheet.append(h("p", { class: "quiet", "data-field": "read-aloud", tabindex: "-1" }, "Сейчас зачитывать нечего."));
      sheet.append(pieceList(view));
    }
    return sheet;
  }

  function hiddenRooms(state) {
    const sc = Orbis.scenarioById(state.package, state.scenario_id);
    if (!sc) return [];
    return sc.components.filter(function (comp) {
      return comp.kind === "room" && !state.revealed.includes(comp.id);
    });
  }

  function endControl() {
    const box = h("div");
    if (!ui.confirmEnd) box.append(button("ask-end", "Закончить сессию"));
    else {
      box.append(h("p", {}, "Сессия закроется в этой вкладке. Снимок на диске останется, только если вы его скачали."));
      box.append(button("end-session", "Да, закончить", null, "primary"));
      box.append(button("cancel-end", "Остаться"));
    }
    return box;
  }

  function fingerprintBlock(state) {
    const box = h("div");
    box.append(h("p", { class: "wordmark" }, "Orbis"));
    box.append(h("p", { class: "eyebrow" }, "Ревизия"));
    box.append(h("p", { class: "fingerprint", "data-field": "revision" }, state.revision_id));
    box.append(h("p", { class: "eyebrow" }, "Отпечаток"));
    box.append(h("p", { class: "fingerprint", "data-field": "fingerprint", title: state.fingerprint }, state.fingerprint));
    return box;
  }

  function flagBlock(state) {
    const box = h("div");
    box.append(h("p", { class: "eyebrow" }, "Тетрадь"));
    const flags = Orbis.activeFlags(state);
    box.append(h("p", { "data-field": "flags" }, flags.length ? flags.join(", ") : "пока пусто"));
    return box;
  }

  function playMargin(state) {
    const view = Orbis.presentation(state);
    const sc = state.scenario_id ? Orbis.scenarioById(state.package, state.scenario_id) : null;
    const aside = h("aside", { class: "margin" });
    aside.append(fingerprintBlock(state));
    aside.append(h("h2", {}, state.package.campaign.title));
    if (state.mode === "play" && sc) {
      aside.append(h("p", { "data-field": "round" }, "Круг " + state.round));
      aside.append(h("p", { class: "eyebrow" }, "Часы"));
      aside.append(h("p", { "data-field": "clock" }, sc.clock.name + " " + state.clock + " / " + sc.clock.limit));
      aside.append(h("p", { class: "eyebrow" }, "За столом"));
      aside.append(h("p", {}, state.names.join(", ")));
      const rooms = hiddenRooms(state);
      aside.append(h("p", { class: "eyebrow" }, "Ещё не выложено"));
      if (!rooms.length) aside.append(h("p", {}, "Скрытых комнат нет."));
      rooms.forEach(function (room) {
        aside.append(h("p", { class: "hidden-room" }, room.label + " — ещё не выложено"));
      });
    }
    aside.append(flagBlock(state));
    if (view.host_note) {
      aside.append(h("p", { class: "eyebrow" }, view.kind === "round" ? "Прошлый шаг" : "Ведущему"));
      const note = h("div", { class: "host-note", "data-field": "host-note" });
      paragraphs(view.host_note).forEach(function (para) { note.append(para); });
      aside.append(note);
    }
    if (view.kind === "ending") {
      aside.append(h("p", { class: "eyebrow" }, "Финал"));
      aside.append(h("p", { "data-field": "ending" }, ENDING_LABEL[view.ending_kind] || view.ending_kind));
    }
    if (ui.playError) aside.append(h("p", { class: "play-error", "data-field": "play-error" }, ui.playError));
    if (ui.paused) {
      aside.append(h("div", { class: "pause-banner" }, [
        h("p", {}, "Пауза. Пакет не меняется, новый текст не появляется."),
        button("resume", "Продолжить", null, "primary"),
      ]));
    } else if (state.mode === "between" || state.mode === "over") {
      if (state.mode === "between") {
        const next = Orbis.scenarioById(state.package, state.next);
        aside.append(h("p", { class: "eyebrow" }, "Следующий сценарий"));
        aside.append(h("p", { "data-field": "next" }, next ? next.title : state.next));
        aside.append(namesEditor(next ? "В сценарии от " + next.investigators.min + " до " + next.investigators.max + "." : ""));
        aside.append(button("begin-next", "Начать следующий сценарий", state.next, "primary"));
        Orbis.availableScenarios(state).filter(function (id) { return id !== state.next; }).forEach(function (id) {
          const spare = Orbis.scenarioById(state.package, id);
          aside.append(button("begin-next", "Запасной вход: " + (spare ? spare.title : id), id));
        });
      } else aside.append(h("p", { "data-field": "next" }, "Дальше в этой ревизии сценария нет."));
    } else if (state.fault) {
      aside.append(h("p", {}, state.fault));
    } else if (view.kind === "setup") aside.append(button("confirm-setup", "Обстановка зачитана", null, "primary"));
    else if (view.kind === "event" && view.choices.length) {
      view.choices.forEach(function (choice) {
        aside.append(button("choice", choice.label, choice.index, "primary"));
      });
    } else if (view.kind === "event" && view.needs_ack) aside.append(button("acknowledge", "Прочитано", null, "primary"));
    else if (view.kind === "empty") aside.append(button("dismiss", "Дальше", null, "primary"));
    else if (view.kind === "ending") aside.append(button("record-ending", "Записать в тетрадь", null, "primary"));
    else {
      if (!state.opening_done) aside.append(button("phase", "Открытие", "opening", "primary"));
      else {
        ["actions_done", "pressure", "creatures"].forEach(function (phase) {
          aside.append(button("phase", PHASE_LABEL[phase], phase));
        });
        if (sc) {
          sc.components.filter(function (comp) { return comp.kind === "marker" && state.revealed.includes(comp.id); }).forEach(function (comp) {
            aside.append(button("marker", "Жетон: " + comp.label, comp.id));
          });
          sc.components.filter(function (comp) { return comp.kind === "creature" && state.revealed.includes(comp.id); }).forEach(function (comp) {
            aside.append(button("creature", "Существо снято: " + comp.label, comp.id));
          });
          sc.events.filter(function (event) { return event.when && event.when.on === "host_calls"; }).forEach(function (event) {
            aside.append(button("host", event.when.label, event.when.call));
          });
        }
      }
    }
    if (!ui.paused) {
      if (state.mode === "play") aside.append(button("pause", "Пауза"));
      const undo = button("undo", "Отменить последний шаг");
      undo.disabled = !state.undo.length;
      aside.append(undo);
    }
    aside.append(button("export-session", "Скачать снимок вечера"));
    aside.append(endControl());
    return aside;
  }

  function homeScreen() {
    const page = h("main", { class: "home" });
    const card = h("div", { class: "sheet-card" });
    card.append(h("div", { class: "seal" }));
    card.append(h("p", { class: "wordmark" }, "Orbis"));
    card.append(h("h1", {}, "Тетрадь ведущего"));
    card.append(h("p", { class: "lede" }, "Один вечер. Один уже собранный пакет. Стол играет своими руками, в эту вкладку смотрит только ведущий."));
    const intake = button("goto-intake", "", null, "door");
    intake.append(h("strong", {}, "Приём данных"), h("span", {}, ui.session
      ? "Сначала закончите партию. Из вечера приём не открывается."
      : "Файл или вставка. Проверка. Ревизия, которую партия уже не переписывает."));
    intake.disabled = !!ui.session;
    const play = button("goto-play", "", null, "door");
    play.append(h("strong", {}, ui.session ? "Продолжить вечер" : "Партия"), h("span", {}, "Фазы, выборы, флаги. Только то, что лежит в ревизии."));
    card.append(intake, play);
    card.append(h("p", { class: "foot" }, "Пример кампании «Соль на пороге» — два вечера и один флаг между ними. Он открывается в приёме данных. Страница никуда не обращается."));
    page.append(card);
    return page;
  }

  function render() {
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    const root = document.getElementById("app");
    let node = homeScreen();
    if (ui.screen === "intake" && !ui.session) node = intakeScreen();
    else if (ui.screen === "play" && !ui.session) node = gateScreen();
    else if (ui.screen === "play" && ui.session) {
      node = h("div", { class: "desk" }, [playSheet(ui.session), playMargin(ui.session)]);
    }
    root.replaceChildren(node);
    if (ui.focusPath) {
      const el = root.querySelector('[data-path="' + (window.CSS && CSS.escape ? CSS.escape(ui.focusPath) : ui.focusPath) + '"]');
      if (el && el.focus) {
        el.focus();
        if (ui.focusPos != null && el.setSelectionRange) {
          const pos = Math.min(ui.focusPos, String(el.value || "").length);
          try { el.setSelectionRange(pos, pos); } catch (err) { /* number inputs */ }
        }
      }
    } else if (ui.screen === "play" && ui.session && ui.session.mode === "play") {
      const read = root.querySelector("[data-field='read-aloud']");
      if (read && read.focus) read.focus();
    }
    if (document.scrollingElement && ui.focusPath) document.scrollingElement.scrollTop = scroll;
    document.title = ui.screen === "play" ? "Orbis — партия" : ui.screen === "intake" ? "Orbis — приём данных" : "Orbis — тетрадь ведущего";
  }

  function editNames(target, path) {
    if (path === "count") {
      let count = Number(target.value);
      if (!Number.isInteger(count)) return;
      count = Math.max(1, Math.min(8, count));
      while (ui.names.length < count) ui.names.push("");
      ui.names = ui.names.slice(0, count);
      return;
    }
    const index = Number(path.slice("name/".length));
    ui.names[index] = target.value;
  }

  function onField(target) {
    const path = target.dataset.path;
    if (!path || path === "source") {
      if (path === "source") ui.intake.text = target.value;
      return;
    }
    ui.focusPath = path;
    ui.focusPos = target.selectionStart;
    if (path === "count" || path.indexOf("name/") === 0) {
      editNames(target, path);
      render();
      return;
    }
    if (path === "rehearse") {
      ui.intake.rehearseId = target.value;
      ui.focusPath = null;
      render();
      return;
    }
    if (!ui.intake.pkg) return;
    if (path.indexOf("flag:") === 0) renameFlag(ui.intake.pkg, Number(path.slice(5)), target.value);
    else if (target.dataset.nil === "null") setPath(ui.intake.pkg, path, target.value ? target.value : null);
    else if (target.dataset.kind === "int") {
      setPath(ui.intake.pkg, path, /^-?\d+$/.test(target.value) ? Number(target.value) : target.value);
    } else if (target.type === "checkbox" && target.dataset.flag) {
      const selected = new Set(getPath(ui.intake.pkg, path) || []);
      if (target.checked) selected.add(target.dataset.flag);
      else selected.delete(target.dataset.flag);
      setPath(ui.intake.pkg, path, (ui.intake.pkg.campaign.flags || []).filter(function (flag) { return selected.has(flag); }));
    } else if (target.type === "checkbox" && target.dataset.present) {
      const parts = path.split("/");
      const sc = ui.intake.pkg.scenarios[Number(parts[1])];
      const selected = new Set(sc.setup.present || []);
      if (target.checked) selected.add(target.dataset.present);
      else selected.delete(target.dataset.present);
      sc.setup.present = sc.components.map(function (comp) { return comp.id; }).filter(function (id) { return selected.has(id); });
    } else setPath(ui.intake.pkg, path, target.value);
    ui.intake.dirty = true;
    refreshIntake();
    render();
  }

  function playAct(action) {
    const result = Orbis.act(ui.session, action);
    ui.focusPath = null;
    if (!result.ok) {
      ui.playError = result.error;
      render();
      return;
    }
    ui.playError = "";
    ui.session = result.state;
    if (result.state.mode !== "play") ui.names = result.state.names.slice();
    persistSession();
    render();
  }

  function beginWith(scenarioId, fresh) {
    ui.focusPath = null;
    const names = ui.names.map(function (name) { return name.trim(); });
    if (fresh) {
      const made = Orbis.createSession(ui.picked.package, ui.picked, names);
      if (!made.ok) {
        ui.playError = made.error;
        render();
        return;
      }
      const begun = Orbis.act(made.state, { type: "begin_scenario", scenario_id: scenarioId });
      if (!begun.ok) {
        ui.playError = begun.error;
        render();
        return;
      }
      ui.session = begun.state;
    } else {
      const named = Orbis.act(ui.session, { type: "set_names", names: names });
      if (!named.ok) {
        ui.playError = named.error;
        render();
        return;
      }
      const begun = Orbis.act(named.state, { type: "begin_scenario", scenario_id: scenarioId });
      if (!begun.ok) {
        ui.session = named.state;
        ui.playError = begun.error;
        persistSession();
        render();
        return;
      }
      ui.session = begun.state;
    }
    ui.playError = "";
    ui.paused = false;
    ui.confirmEnd = false;
    ui.screen = "play";
    persistSession();
    render();
  }

  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const arg = target.dataset.arg;
    ui.focusPath = null;
    if (action === "home") {
      if (ui.session) return;
      ui.screen = "home";
      ui.playError = "";
      render();
    } else if (action === "goto-intake") {
      if (ui.session) return;
      ui.screen = "intake";
      render();
    } else if (action === "goto-play") {
      ui.screen = "play";
      ui.paused = false;
      ui.confirmEnd = false;
      if (!ui.session && !ui.picked && ui.library[0]) ui.picked = ui.library[0];
      render();
    } else if (action === "sample") {
      adoptText(globalThis.ORBIS_SAMPLE_YAML || "");
      render();
    } else if (action === "parse") {
      adoptText(ui.intake.text);
      render();
    } else if (action === "download-package") {
      if (ui.intake.pkg) download("orbis-package.json", ui.intake.pkg);
    } else if (action === "seal") {
      const sealed = Orbis.seal(ui.intake.pkg);
      if (!sealed.ok) {
        ui.intake.errors = sealed.errors;
        render();
        return;
      }
      rememberRevision(sealed.revision);
      download("orbis-" + sealed.revision.revision_id + ".json", sealed.revision);
      ui.intake.status = "Ревизия " + sealed.revision.revision_id + " отмечена. Отпечаток " + sealed.revision.fingerprint + ".";
      render();
    } else if (action === "show-rehearse") {
      ui.intake.view = "rehearse";
      render();
    } else if (action === "show-form") {
      ui.intake.view = "form";
      render();
    } else if (action === "play-sealed") {
      ui.screen = "play";
      ui.playError = "";
      render();
    } else if (action === "pick") {
      ui.picked = ui.library.find(function (item) { return item.fingerprint === arg; }) || null;
      ui.playError = "";
      render();
    } else if (action === "begin-fresh") beginWith(arg, true);
    else if (action === "begin-next") beginWith(arg, false);
    else if (action === "confirm-setup") playAct({ type: "confirm_setup" });
    else if (action === "phase") playAct({ type: "phase", phase: arg });
    else if (action === "choice") playAct({ type: "choice", index: Number(arg) });
    else if (action === "acknowledge") playAct({ type: "acknowledge" });
    else if (action === "dismiss") playAct({ type: "dismiss" });
    else if (action === "record-ending") playAct({ type: "record_ending" });
    else if (action === "marker") playAct({ type: "marker", component: arg });
    else if (action === "creature") playAct({ type: "creature_down", component: arg });
    else if (action === "host") playAct({ type: "host_call", call: arg });
    else if (action === "undo") playAct({ type: "undo" });
    else if (action === "pause") { ui.paused = true; render(); }
    else if (action === "resume") { ui.paused = false; render(); }
    else if (action === "export-session") {
      if (ui.session) download("orbis-session-" + ui.session.fingerprint.slice(0, 8) + ".json", Orbis.exportSession(ui.session));
    } else if (action === "ask-end") { ui.confirmEnd = true; render(); }
    else if (action === "cancel-end") { ui.confirmEnd = false; render(); }
    else if (action === "end-session") {
      ui.session = null;
      ui.paused = false;
      ui.confirmEnd = false;
      ui.playError = "";
      ui.screen = "home";
      persistSession();
      render();
    }
  }

  document.getElementById("app").addEventListener("click", onClick);
  document.getElementById("app").addEventListener("input", function (event) {
    const target = event.target;
    if (!target || target.type === "checkbox" || target.tagName === "SELECT") return;
    onField(target);
  });
  document.getElementById("app").addEventListener("change", function (event) {
    if (event.target && (event.target.tagName === "SELECT" || event.target.type === "checkbox")) onField(event.target);
  });

  loadLibrary();
  try {
    const saved = storageGet(SESSION);
    if (saved) {
      const opened = Orbis.importSession(JSON.parse(saved));
      if (opened.ok) {
        ui.session = opened.state;
        ui.names = opened.state.names.slice();
      }
    }
  } catch (err) { /* start at the doors */ }

  window.__orbis = {
    get state() { return ui.session; },
    get screen() { return ui.screen; },
    get intakeErrors() { return ui.intake.errors; },
    Orbis: Orbis,
  };

  render();
})();
