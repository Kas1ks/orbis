/* Orbis keeper engine. Closed effect list, no network, no generation.
   Loaded as a classic script (globalThis.Orbis) and as a CommonJS module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.Orbis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const EFFECT_KEYS = ["reveal", "hide", "set_flag", "clear_flag", "add_clock", "go", "end"];
  const PHASES = ["opening", "actions_done", "pressure", "creatures"];
  const EVENT_WHENS = ["session_start", "phase", "marker_used", "creature_down", "clock_at", "flag_is", "host_calls"];
  const ENDING_WHENS = ["flag_is", "clock_at", "event"];
  const WHEN_FIELDS = {
    session_start: [],
    phase: ["phase"],
    marker_used: ["component"],
    creature_down: ["component"],
    clock_at: ["value"],
    flag_is: ["flag"],
    host_calls: ["call", "label"],
    event: ["event"],
  };
  const TOP_KEYS = ["format", "campaign", "scenarios"];
  const CAMPAIGN_KEYS = ["id", "title", "pitch", "flags", "scenarios", "start"];
  const SCENARIO_KEYS = ["id", "title", "investigators", "setup", "clock", "components", "events", "endings", "spare"];
  const SETUP_KEYS = ["read_aloud", "host_note", "present"];
  const CLOCK_KEYS = ["name", "start", "limit"];
  const COMPONENT_KEYS = ["id", "kind", "label", "host_note", "at"];
  const EVENT_KEYS = ["id", "when", "read_aloud", "host_note", "choices", "effects"];
  const CHOICE_KEYS = ["label", "effects"];
  const ENDING_KEYS = ["id", "kind", "when", "read_aloud", "host_note", "set_flags", "next"];
  const KINDS = ["room", "marker", "creature", "object"];
  const ENDING_KINDS = ["success", "failure", "other"];
  const ID_RE = /^[a-z][a-z0-9_]*$/;
  const BANNED_KEY = /^(model|prompt|llm|ai|draft|endpoint|webhook|url|href)$/i;
  const TOKEN_RE = /\{([^{}]+)\}/g;
  const ALLOWED_TOKEN = /^(investigators|names|clock|clock_name|component:[a-z][a-z0-9_]*)$/;

  function yamlLib() {
    const lib = globalThis.jsyaml;
    if (!lib || typeof lib.load !== "function") {
      throw new Error("js-yaml не подключён");
    }
    return lib;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isObject(value)) {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
      return out;
    }
    return value;
  }

  function fnv1a(text) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, "0");
  }

  function identify(pkg) {
    const fingerprint = fnv1a(JSON.stringify(canonicalize(pkg)));
    return { fingerprint, revision_id: "rev-" + fingerprint.slice(0, 8) };
  }

  function parseSource(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!raw) return { ok: false, error: "Пусто. Вставьте пакет или откройте файл." };
    try {
      const data = raw.startsWith("{")
        ? JSON.parse(raw)
        : yamlLib().load(raw, { schema: yamlLib().CORE_SCHEMA });
      if (!isObject(data)) {
        return { ok: false, error: "Пакет должен быть одним объектом, не списком и не строкой." };
      }
      return { ok: true, package: data };
    } catch (err) {
      const detail = err && err.message ? " " + err.message : "";
      return { ok: false, error: "Текст не читается как YAML или JSON." + detail };
    }
  }

  function pushError(errors, path, message) {
    errors.push({ path: path || "пакет", message });
  }

  function unknownKeys(errors, obj, allowed, path) {
    if (!isObject(obj)) return;
    for (const key of Object.keys(obj)) {
      if (BANNED_KEY.test(key)) {
        pushError(errors, path + "/" + key, "Ключ «" + key + "» в пакет нельзя. Сюжет не спрашивает модель и никуда не обращается.");
      } else if (!allowed.includes(key)) {
        pushError(errors, path + "/" + key, "Неизвестный ключ «" + key + "». Новую команду в пакет добавить нельзя.");
      }
    }
  }

  function needString(errors, obj, key, path) {
    if (!obj || typeof obj[key] !== "string") {
      pushError(errors, path + "/" + key, "Нужна строка «" + key + "».");
      return "";
    }
    return obj[key];
  }

  function needId(errors, value, path, what) {
    if (typeof value !== "string" || !ID_RE.test(value)) {
      pushError(errors, path, (what || "Идентификатор") + " пишется латиницей и подчёркиванием, с маленькой буквы.");
      return false;
    }
    return true;
  }

  function scanText(errors, text, path, componentIds) {
    if (typeof text !== "string") return;
    if (/https?:\/\/|www\./i.test(text)) {
      pushError(errors, path, "В пакете не бывает адреса сети. Вечер никуда не обращается.");
    }
    const leftovers = text.replace(/\{(investigators|names|clock|clock_name|component:[a-z][a-z0-9_]*)\}/g, "");
    if (/[{}]/.test(leftovers)) {
      pushError(errors, path, "В тексте подстановка не из списка. Можно только {investigators}, {names}, {clock}, {clock_name} и {component:id}.");
    }
    const seen = new Set();
    text.replace(TOKEN_RE, function (_, body) {
      if (!ALLOWED_TOKEN.test(body)) return _;
      if (body.indexOf("component:") === 0 && !seen.has(body)) {
        seen.add(body);
        const id = body.slice("component:".length);
        if (!componentIds.has(id)) {
          pushError(errors, path, "Подстановка {component:" + id + "} зовёт компонент, которого в пакете нет.");
        }
      }
      return _;
    });
  }

  function effectList(errors, list, path, ctx) {
    if (list == null) return [];
    if (!Array.isArray(list)) {
      pushError(errors, path, "Команды нужны списком.");
      return [];
    }
    let sawEnd = false;
    let sawGo = false;
    list.forEach(function (eff, index) {
      const at = path + "/" + index;
      if (!isObject(eff)) {
        pushError(errors, at, "Команда должна быть одним ключом из закрытого списка.");
        return;
      }
      const keys = Object.keys(eff);
      if (keys.length !== 1) {
        pushError(errors, at, "Команда должна быть одним ключом, а не сразу несколькими.");
        return;
      }
      const key = keys[0];
      if (BANNED_KEY.test(key)) {
        pushError(errors, at + "/" + key, "Команды «спросить модель» нет.");
        return;
      }
      if (!EFFECT_KEYS.includes(key)) {
        pushError(errors, at + "/" + key, "Команда «" + key + "» не из списка. Можно только reveal, hide, set_flag, clear_flag, add_clock, go, end.");
        return;
      }
      const value = eff[key];
      if (key === "add_clock") {
        if (!Number.isInteger(value)) pushError(errors, at, "add_clock ждёт целое число.");
        return;
      }
      if (typeof value !== "string" || !value) {
        pushError(errors, at, "У команды «" + key + "» нет цели.");
        return;
      }
      if (key === "reveal" || key === "hide") {
        if (!ctx.components.has(value)) pushError(errors, at, "Команда «" + key + "» ссылается на компонент «" + value + "», которого нет.");
      } else if (key === "set_flag" || key === "clear_flag") {
        if (!ctx.flags.has(value)) pushError(errors, at, "Флаг «" + value + "» не объявлен в тетради кампании.");
        if (key === "set_flag") ctx.flagSet.add(value);
      } else if (key === "go") {
        sawGo = true;
        if (!ctx.events.has(value)) pushError(errors, at, "Переход go ведёт в событие «" + value + "», которого нет.");
      } else if (key === "end") {
        sawEnd = true;
        if (!ctx.endings.has(value)) pushError(errors, at, "Финал «" + value + "» в команде end не найден.");
        ctx.endFrom.add(value);
      }
    });
    if (sawGo && sawEnd) {
      pushError(errors, path, "В одном шаге и переход go, и финал end. Оставьте что-то одно.");
    }
    return list;
  }

  function checkWhen(errors, when, path, allowed, ctx, ownerKind) {
    if (!isObject(when)) {
      pushError(errors, path, "Повод нужен объектом с ключом on.");
      return;
    }
    unknownKeys(errors, when, ["on"].concat(WHEN_FIELDS[when.on] || []), path);
    if (typeof when.on !== "string" || !allowed.includes(when.on)) {
      pushError(errors, path + "/on", ownerKind === "ending"
        ? "У финала повод только flag_is, clock_at или event."
        : "Повод события не из списка. Можно session_start, phase, marker_used, creature_down, clock_at, flag_is, host_calls.");
      return;
    }
    const fields = WHEN_FIELDS[when.on];
    fields.forEach(function (field) {
      if (when[field] == null || when[field] === "") {
        pushError(errors, path + "/" + field, "Поводу «" + when.on + "» не хватает «" + field + "».");
      }
    });
    if (when.on === "phase" && !PHASES.includes(when.phase)) {
      pushError(errors, path + "/phase", "Фаза должна быть opening, actions_done, pressure или creatures.");
    }
    if (when.on === "marker_used" || when.on === "creature_down") {
      const comp = ctx.componentById.get(when.component);
      const expect = when.on === "marker_used" ? "marker" : "creature";
      if (!comp) pushError(errors, path + "/component", "Повод ссылается на компонент «" + when.component + "», которого нет.");
      else if (comp.kind !== expect) {
        pushError(errors, path + "/component", "Для этого повода нужен компонент типа «" + (expect === "marker" ? "жетон" : "существо") + "».");
      }
    }
    if (when.on === "clock_at") {
      if (!Number.isInteger(when.value)) pushError(errors, path + "/value", "Порог часов нужен целым числом.");
      else if (ctx.clock && when.value < ctx.clock.start) {
        pushError(errors, path + "/value", "Часы начинают с " + ctx.clock.start + ", порог " + when.value + " уже позади и не наступит.");
      }
    }
    if (when.on === "flag_is") {
      if (!ctx.flags.has(when.flag)) pushError(errors, path + "/flag", "Флаг «" + when.flag + "» не объявлен в тетради кампании.");
    }
    if (when.on === "host_calls") {
      if (typeof when.call === "string" && !ID_RE.test(when.call)) {
        pushError(errors, path + "/call", "Имя такта пишется латиницей и подчёркиванием.");
      }
      if (typeof when.label === "string" && !when.label.trim()) {
        pushError(errors, path + "/label", "У именного такта пустая подпись кнопки.");
      }
      if (typeof when.call === "string") {
        if (ctx.calls.has(when.call)) pushError(errors, path + "/call", "Такт «" + when.call + "» назван дважды.");
        ctx.calls.add(when.call);
      }
    }
    if (when.on === "event" && !ctx.events.has(when.event)) {
      pushError(errors, path + "/event", "Финал указывает на событие «" + when.event + "», которого нет.");
    }
  }

  function eventEffects(event) {
    const list = [];
    if (Array.isArray(event.effects)) list.push.apply(list, event.effects);
    (event.choices || []).forEach(function (choice) {
      if (choice && Array.isArray(choice.effects)) list.push.apply(list, choice.effects);
    });
    return list;
  }

  function choiceExits(event) {
    const buckets = [];
    if (event.choices && event.choices.length) {
      event.choices.forEach(function (choice) { buckets.push(choice.effects || []); });
    } else if (event.effects && event.effects.length) {
      buckets.push(event.effects);
    }
    return buckets.map(function (effects) {
      let ends = false;
      const gos = [];
      effects.forEach(function (eff) {
        if (!isObject(eff)) return;
        if (Object.prototype.hasOwnProperty.call(eff, "end")) ends = true;
        if (Object.prototype.hasOwnProperty.call(eff, "go") && typeof eff.go === "string") gos.push(eff.go);
      });
      return { ends: ends, gos: gos };
    });
  }

  function cycleErrors(errors, events, path) {
    const byId = new Map();
    events.forEach(function (event) { if (event && event.id) byId.set(event.id, event); });
    const canEnd = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      byId.forEach(function (event, id) {
        if (canEnd.has(id)) return;
        const exits = choiceExits(event);
        const ok = exits.some(function (exit) {
          if (exit.ends) return true;
          return exit.gos.some(function (target) { return canEnd.has(target); });
        });
        if (ok) {
          canEnd.add(id);
          grew = true;
        }
      });
    }
    const state = new Map();
    const stack = [];
    function visit(id) {
      state.set(id, "in");
      stack.push(id);
      const event = byId.get(id);
      choiceExits(event).forEach(function (exit) {
        exit.gos.forEach(function (next) {
          if (!byId.has(next)) return;
          const mark = state.get(next);
          if (mark === "in") {
            const loop = stack.slice(stack.indexOf(next));
            if (loop.some(function (node) { return !canEnd.has(node); })) {
              pushError(errors, path, "События " + loop.map(function (node) { return "«" + node + "»"; }).join(", ") + " ходят по кругу и ни одним выбором не доходят до финала.");
            }
          } else if (mark !== "out") visit(next);
        });
      });
      stack.pop();
      state.set(id, "out");
    }
    byId.forEach(function (_, id) { if (!state.has(id)) visit(id); });
  }

  function reachableSet(pkg) {
    const byId = new Map(pkg.scenarios.map(function (sc) { return [sc.id, sc]; }));
    const seen = new Set();
    const queue = [pkg.campaign.start];
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      byId.get(id).endings.forEach(function (ending) {
        if (ending && ending.next && ending.next !== "stop" && !seen.has(ending.next)) queue.push(ending.next);
      });
    }
    return seen;
  }

  function validate(pkg) {
    const errors = [];
    if (!isObject(pkg)) {
      pushError(errors, "пакет", "Пакет должен быть объектом.");
      return errors;
    }
    unknownKeys(errors, pkg, TOP_KEYS, "пакет");
    if (pkg.format !== "orbis/1") pushError(errors, "format", "Нужен format: orbis/1.");
    if (!isObject(pkg.campaign)) {
      pushError(errors, "campaign", "Нет кампании.");
      return errors;
    }
    const campaign = pkg.campaign;
    unknownKeys(errors, campaign, CAMPAIGN_KEYS, "campaign");
    needId(errors, campaign.id, "campaign/id", "Идентификатор кампании");
    needString(errors, campaign, "title", "campaign");
    needString(errors, campaign, "pitch", "campaign");
    if (!Array.isArray(campaign.flags) || campaign.flags.some(function (flag) { return typeof flag !== "string"; })) {
      pushError(errors, "campaign/flags", "Тетрадь флагов нужна списком строк.");
    }
    const flags = new Set();
    (campaign.flags || []).forEach(function (flag, index) {
      if (!needId(errors, flag, "campaign/flags/" + index, "Флаг")) return;
      if (flags.has(flag)) pushError(errors, "campaign/flags/" + flag, "Флаг «" + flag + "» объявлен дважды.");
      flags.add(flag);
    });
    if (!Array.isArray(campaign.scenarios) || !campaign.scenarios.length) {
      pushError(errors, "campaign/scenarios", "В кампании нужен список сценариев.");
    }
    if (!Array.isArray(pkg.scenarios) || !pkg.scenarios.length) {
      pushError(errors, "scenarios", "Сценарии нужны списком объектов.");
      return errors;
    }
    const scenarioIds = new Set();
    pkg.scenarios.forEach(function (sc, index) {
      if (!isObject(sc)) {
        pushError(errors, "scenarios/" + index, "Сценарий должен быть объектом.");
        return;
      }
      if (needId(errors, sc.id, "scenarios/" + index + "/id", "Идентификатор сценария")) {
        if (scenarioIds.has(sc.id)) pushError(errors, "scenarios/" + sc.id, "Сценарий «" + sc.id + "» повторяется.");
        scenarioIds.add(sc.id);
      }
    });
    (campaign.scenarios || []).forEach(function (id, index) {
      if (!scenarioIds.has(id)) pushError(errors, "campaign/scenarios/" + index, "В списке кампании есть «" + id + "», а самого сценария нет.");
    });
    scenarioIds.forEach(function (id) {
      if (!(campaign.scenarios || []).includes(id)) {
        pushError(errors, "scenarios/" + id, "Сценарий «" + id + "» лежит в пакете, но не вписан в список кампании.");
      }
    });
    if (!scenarioIds.has(campaign.start)) {
      pushError(errors, "campaign/start", "Старт «" + campaign.start + "» не совпадает ни с одним сценарием.");
    }

    const componentIds = new Set();
    pkg.scenarios.forEach(function (sc) {
      if (!isObject(sc) || !Array.isArray(sc.components)) return;
      sc.components.forEach(function (comp) {
        if (comp && typeof comp.id === "string") componentIds.add(comp.id);
      });
    });
    scanText(errors, campaign.title, "campaign/title", componentIds);
    scanText(errors, campaign.pitch, "campaign/pitch", componentIds);

    const flagSet = new Set();
    pkg.scenarios.forEach(function (sc, index) {
      if (!isObject(sc)) return;
      const sid = typeof sc.id === "string" ? sc.id : String(index);
      const path = "scenarios/" + sid;
      unknownKeys(errors, sc, SCENARIO_KEYS, path);
      needString(errors, sc, "title", path);
      if (Object.prototype.hasOwnProperty.call(sc, "spare") && typeof sc.spare !== "boolean") {
        pushError(errors, path + "/spare", "Запасной вход помечается как spare: true.");
      }
      if (!isObject(sc.investigators)) pushError(errors, path + "/investigators", "Нужны границы числа сыщиков, min и max.");
      else {
        unknownKeys(errors, sc.investigators, ["min", "max"], path + "/investigators");
        const min = sc.investigators.min;
        const max = sc.investigators.max;
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
          pushError(errors, path + "/investigators", "Число сыщиков: min и max — целые, min хотя бы 1, max не меньше min.");
        }
      }
      if (!isObject(sc.setup)) pushError(errors, path + "/setup", "Нет стартовой выкладки.");
      else {
        unknownKeys(errors, sc.setup, SETUP_KEYS, path + "/setup");
        needString(errors, sc.setup, "read_aloud", path + "/setup");
        needString(errors, sc.setup, "host_note", path + "/setup");
        scanText(errors, sc.setup.read_aloud, path + "/setup/read_aloud", componentIds);
        scanText(errors, sc.setup.host_note, path + "/setup/host_note", componentIds);
        if (!Array.isArray(sc.setup.present)) pushError(errors, path + "/setup/present", "Стартовая выкладка нужна списком идентификаторов.");
      }
      if (!isObject(sc.clock)) pushError(errors, path + "/clock", "У сценария нет часов.");
      else {
        unknownKeys(errors, sc.clock, CLOCK_KEYS, path + "/clock");
        needString(errors, sc.clock, "name", path + "/clock");
        scanText(errors, sc.clock.name, path + "/clock/name", componentIds);
        if (!Number.isInteger(sc.clock.start) || sc.clock.start < 0 || !Number.isInteger(sc.clock.limit) || sc.clock.limit <= sc.clock.start) {
          pushError(errors, path + "/clock", "Часы: start целое от нуля, limit — целое строго больше start.");
        }
      }
      const ctx = {
        flags: flags,
        flagSet: flagSet,
        components: new Set(),
        componentById: new Map(),
        events: new Set(),
        endings: new Set(),
        endFrom: new Set(),
        calls: new Set(),
        clock: isObject(sc.clock) ? sc.clock : null,
      };
      if (!Array.isArray(sc.components)) pushError(errors, path + "/components", "Компоненты нужны списком.");
      else sc.components.forEach(function (comp, ci) {
        const at = path + "/components/" + (comp && comp.id ? comp.id : ci);
        if (!isObject(comp)) {
          pushError(errors, at, "Компонент должен быть объектом.");
          return;
        }
        unknownKeys(errors, comp, COMPONENT_KEYS, at);
        if (needId(errors, comp.id, at + "/id", "Идентификатор компонента")) {
          if (ctx.components.has(comp.id)) pushError(errors, at, "Компонент «" + comp.id + "» повторяется.");
          ctx.components.add(comp.id);
          ctx.componentById.set(comp.id, comp);
        }
        if (!KINDS.includes(comp.kind)) pushError(errors, at + "/kind", "Тип компонента: room, marker, creature или object.");
        needString(errors, comp, "label", at);
        needString(errors, comp, "host_note", at);
        scanText(errors, comp.label, at + "/label", componentIds);
        scanText(errors, comp.host_note, at + "/host_note", componentIds);
        if (comp.kind === "room") {
          if (comp.at != null) pushError(errors, at + "/at", "У комнаты не бывает поля «где лежит».");
        } else if (comp.at != null && typeof comp.at !== "string") {
          pushError(errors, at + "/at", "Место компонента — идентификатор комнаты или null.");
        }
      });
      ctx.componentById.forEach(function (comp) {
        if (comp.at != null && comp.kind !== "room") {
          const room = ctx.componentById.get(comp.at);
          if (!room || room.kind !== "room") {
            pushError(errors, path + "/components/" + comp.id + "/at", "«" + comp.label + "» лежит не в комнате: «" + comp.at + "».");
          }
        }
      });
      if (isObject(sc.setup) && Array.isArray(sc.setup.present)) {
        const seenPresent = new Set();
        sc.setup.present.forEach(function (id, pi) {
          if (!ctx.components.has(id)) pushError(errors, path + "/setup/present/" + pi, "На старте лежит «" + id + "», такого компонента нет.");
          if (seenPresent.has(id)) pushError(errors, path + "/setup/present/" + id, "«" + id + "» дважды в стартовой выкладке.");
          seenPresent.add(id);
        });
      }
      if (!Array.isArray(sc.events) || !sc.events.length) pushError(errors, path + "/events", "В сценарии нет событий.");
      else sc.events.forEach(function (event, ei) {
        if (!isObject(event)) {
          pushError(errors, path + "/events/" + ei, "Событие должно быть объектом.");
          return;
        }
        if (typeof event.id === "string") {
          if (ctx.events.has(event.id)) pushError(errors, path + "/events/" + event.id, "Событие «" + event.id + "» повторяется.");
          ctx.events.add(event.id);
        }
      });
      if (!Array.isArray(sc.endings) || !sc.endings.length) pushError(errors, path + "/endings", "У сценария нет финалов.");
      else sc.endings.forEach(function (ending) {
        if (ending && typeof ending.id === "string") ctx.endings.add(ending.id);
      });

      (sc.events || []).forEach(function (event, ei) {
        if (!isObject(event)) return;
        const eid = typeof event.id === "string" ? event.id : String(ei);
        const ep = path + "/events/" + eid;
        unknownKeys(errors, event, EVENT_KEYS, ep);
        needId(errors, event.id, ep + "/id", "Идентификатор события");
        checkWhen(errors, event.when, ep + "/when", EVENT_WHENS, ctx, "event");
        if (typeof event.read_aloud !== "string") pushError(errors, ep + "/read_aloud", "Нет текста для стола. Пустым он может быть только у немого шага.");
        if (typeof event.host_note !== "string") pushError(errors, ep + "/host_note", "Нет пометки ведущему. Она может быть пустой строкой.");
        scanText(errors, event.read_aloud, ep + "/read_aloud", componentIds);
        scanText(errors, event.host_note, ep + "/host_note", componentIds);
        const hasChoices = Array.isArray(event.choices) && event.choices.length > 0;
        const hasEffects = Array.isArray(event.effects) && event.effects.length > 0;
        if (event.choices != null && !Array.isArray(event.choices)) pushError(errors, ep + "/choices", "Выборы нужны списком.");
        if (hasChoices && hasEffects) {
          pushError(errors, ep, "Команды пишутся либо в выборах, либо на самом событии, если выбора нет.");
        }
        if (hasChoices) {
          event.choices.forEach(function (choice, ci) {
            const cp = ep + "/choices/" + ci;
            if (!isObject(choice)) {
              pushError(errors, cp, "Выбор должен быть объектом.");
              return;
            }
            unknownKeys(errors, choice, CHOICE_KEYS, cp);
            if (typeof choice.label !== "string" || !choice.label.trim()) pushError(errors, cp + "/label", "У выбора пустая подпись.");
            scanText(errors, choice.label, cp + "/label", componentIds);
            effectList(errors, choice.effects || [], cp + "/effects", ctx);
          });
        } else {
          effectList(errors, event.effects || [], ep + "/effects", ctx);
        }
        const silentOk = typeof event.read_aloud === "string" && event.read_aloud.trim() === "" && !hasChoices && hasEffects;
        const spoken = typeof event.read_aloud === "string" && event.read_aloud.trim() !== "";
        if (!spoken && !silentOk) {
          pushError(errors, ep + "/read_aloud", "Пустой текст для стола можно оставить только когда у события есть команды и нет выбора. Иначе стол не услышит шаг, а сам он никуда не идёт.");
        }
      });

      let successes = 0;
      let failures = 0;
      (sc.endings || []).forEach(function (ending, ei) {
        const eid = ending && ending.id ? ending.id : String(ei);
        const ep = path + "/endings/" + eid;
        if (!isObject(ending)) {
          pushError(errors, ep, "Финал должен быть объектом.");
          return;
        }
        unknownKeys(errors, ending, ENDING_KEYS, ep);
        needId(errors, ending.id, ep + "/id", "Идентификатор финала");
        if (!ENDING_KINDS.includes(ending.kind)) pushError(errors, ep + "/kind", "Финал бывает success, failure или other.");
        if (ending.kind === "success") successes += 1;
        if (ending.kind === "failure") failures += 1;
        checkWhen(errors, ending.when, ep + "/when", ENDING_WHENS, ctx, "ending");
        needString(errors, ending, "read_aloud", ep);
        needString(errors, ending, "host_note", ep);
        scanText(errors, ending.read_aloud, ep + "/read_aloud", componentIds);
        scanText(errors, ending.host_note, ep + "/host_note", componentIds);
        if (typeof ending.read_aloud === "string" && !ending.read_aloud.trim()) {
          pushError(errors, ep + "/read_aloud", "У финала пустой текст. Стол должен услышать, чем кончился вечер.");
        }
        if (!Array.isArray(ending.set_flags)) pushError(errors, ep + "/set_flags", "set_flags нужен списком, даже пустым.");
        else ending.set_flags.forEach(function (flag) {
          if (!flags.has(flag)) pushError(errors, ep + "/set_flags", "Финал ставит флаг «" + flag + "», которого нет в тетради.");
          else flagSet.add(flag);
        });
        if (ending.next !== "stop" && !scenarioIds.has(ending.next)) {
          pushError(errors, ep + "/next", "Дальше указано «" + ending.next + "». Нужен сценарий из пакета или stop.");
        }
        if (ending.when && ending.when.on === "event" && ctx.events.has(ending.when.event) && !ctx.endFrom.has(ending.id)) {
          pushError(errors, ep, "Финал «" + ending.id + "» говорит, что его открывает событие «" + ending.when.event + "», но ни одна команда end туда не ведёт.");
        }
      });
      if (!successes) pushError(errors, path + "/endings", "В сценарии «" + (sc.title || sid) + "» нет финала-успеха.");
      if (!failures) pushError(errors, path + "/endings", "В сценарии «" + (sc.title || sid) + "» нет финала-провала.");
      if (Array.isArray(sc.events)) cycleErrors(errors, sc.events.filter(isObject), path + "/events");
    });

    flags.forEach(function (flag) {
      if (!flagSet.has(flag)) {
        pushError(errors, "campaign/flags/" + flag, "Флаг «" + flag + "» есть в тетради, но ни событие, ни финал его не ставит.");
      }
    });

    if (isObject(pkg.campaign) && Array.isArray(pkg.scenarios) && scenarioIds.has(pkg.campaign.start) && pkg.scenarios.every(isObject)) {
      try {
        const seen = reachableSet(pkg);
        pkg.scenarios.forEach(function (sc) {
          if (!sc || !sc.id || seen.has(sc.id) || sc.spare === true) return;
          pushError(errors, "scenarios/" + sc.id, "Сценарий «" + (sc.title || sc.id) + "» ниоткуда не открывается. Пометьте его запасным входом (spare: true) или дайте на него переход.");
        });
      } catch (err) {
        pushError(errors, "campaign", "Не удалось проверить, какие сценарии достижимы.");
      }
    }
    return errors;
  }

  function scenarioById(pkg, id) {
    return (pkg.scenarios || []).find(function (sc) { return sc.id === id; }) || null;
  }

  function currentScenario(state) {
    if (!state || !state.scenario_id) return null;
    return scenarioById(state.package, state.scenario_id);
  }

  function componentOf(sc, id) {
    return sc.components.find(function (comp) { return comp.id === id; }) || null;
  }

  function normalizeNames(names) {
    if (!Array.isArray(names) || !names.length) return { ok: false, error: "Нужно хотя бы одно имя сыщика." };
    const clean = names.map(function (name) { return String(name || "").trim(); });
    if (clean.some(function (name) { return !name; })) {
      return { ok: false, error: "Пустое имя не подставится в текст. Впишите его или уменьшите число сыщиков." };
    }
    return { ok: true, names: clean };
  }

  function createSession(pkg, meta, names) {
    const errors = validate(pkg);
    if (errors.length) return { ok: false, error: "Пакет не готов к партии.", errors };
    const id = identify(pkg);
    if (!meta || meta.fingerprint !== id.fingerprint) {
      return { ok: false, error: "Отпечаток ревизии не совпал с пакетом." };
    }
    const named = normalizeNames(names);
    if (!named.ok) return named;
    return {
      ok: true,
      state: {
        mode: "gate",
        revision_id: id.revision_id,
        fingerprint: id.fingerprint,
        package: clone(pkg),
        names: named.names,
        flags: [],
        closed: [],
        next: pkg.campaign.start,
        scenario_id: null,
        revealed: [],
        clock: 0,
        opening_done: false,
        round: 1,
        last_phase: null,
        bump_round: false,
        step: null,
        queue: [],
        pending: { placed: [], removed: [] },
        banner: null,
        fault: null,
        edges: [],
        previous_note: "",
        undo: [],
      },
    };
  }

  function availableScenarios(state) {
    if (!state || state.next === "stop") return [];
    const ids = [];
    if (state.next) ids.push(state.next);
    (state.package.scenarios || []).forEach(function (sc) {
      if (sc.spare === true && !ids.includes(sc.id)) ids.push(sc.id);
    });
    return ids;
  }

  function bare(state) {
    const snap = clone(state);
    delete snap.package;
    snap.undo = [];
    return snap;
  }

  function fail(state, error) {
    return { ok: false, state: state, error: error };
  }

  function commit(prev, working) {
    working.package = prev.package;
    working.undo = prev.undo.concat([bare(prev)]).slice(-40);
    return { ok: true, state: working };
  }

  function work(state) {
    const copy = clone(state);
    copy.package = state.package;
    return copy;
  }

  function takePending(state) {
    const placed = state.pending.placed.splice(0, state.pending.placed.length);
    const removed = state.pending.removed.splice(0, state.pending.removed.length);
    return { placed: placed, removed: removed };
  }

  function rememberNote(state) {
    const sc = currentScenario(state);
    if (!sc || !state.step) return;
    if (state.step.kind === "event") {
      const event = sc.events.find(function (item) { return item.id === state.step.id; });
      if (event) state.previous_note = event.host_note || "";
    } else if (state.step.kind === "setup") state.previous_note = sc.setup.host_note || "";
    else if (state.step.kind === "ending") {
      const ending = sc.endings.find(function (item) { return item.id === state.step.id; });
      if (ending) state.previous_note = ending.host_note || "";
    }
  }

  function show(state, step) {
    const pending = takePending(state);
    step.placed = pending.placed;
    step.removed = pending.removed;
    rememberNote(state);
    state.step = step;
    state.banner = null;
  }

  function settle(state) {
    rememberNote(state);
    const pending = takePending(state);
    state.step = null;
    state.banner = pending;
    if (state.bump_round) {
      state.round += 1;
      state.bump_round = false;
    }
  }

  function enqueue(state, item) {
    state.queue.push(item);
  }

  function queueClockValue(state, value) {
    const sc = currentScenario(state);
    if (!sc) return;
    sc.events.forEach(function (event) {
      if (event.when.on === "clock_at" && event.when.value === value) {
        const edge = "clock:" + value + ":" + event.id;
        if (state.edges.includes(edge)) return;
        state.edges.push(edge);
        enqueue(state, { kind: "event", id: event.id });
      }
    });
    sc.endings.forEach(function (ending) {
      if (ending.when.on === "clock_at" && ending.when.value === value) {
        const edge = "endclock:" + value + ":" + ending.id;
        if (state.edges.includes(edge)) return;
        state.edges.push(edge);
        enqueue(state, { kind: "ending", id: ending.id });
      }
    });
  }

  function queueFlagTriggers(state, flag) {
    const sc = currentScenario(state);
    if (!sc) return;
    sc.events.forEach(function (event) {
      if (event.when.on === "flag_is" && event.when.flag === flag) {
        const edge = "flag:" + flag + ":" + event.id;
        if (state.edges.includes(edge)) return;
        state.edges.push(edge);
        enqueue(state, { kind: "event", id: event.id });
      }
    });
    sc.endings.forEach(function (ending) {
      if (ending.when.on === "flag_is" && ending.when.flag === flag) {
        const edge = "endflag:" + flag + ":" + ending.id;
        if (state.edges.includes(edge)) return;
        state.edges.push(edge);
        enqueue(state, { kind: "ending", id: ending.id });
      }
    });
  }

  function addClock(state, delta) {
    if (!Number.isInteger(delta) || delta === 0) return;
    const before = state.clock;
    let next = before + delta;
    if (next < 0) next = 0;
    if (next === before) return;
    state.clock = next;
    const step = next > before ? 1 : -1;
    for (let value = before + step; step > 0 ? value <= next : value >= next; value += step) {
      queueClockValue(state, value);
    }
  }

  function setFlag(state, flag) {
    if (state.flags.includes(flag)) return;
    state.flags.push(flag);
    queueFlagTriggers(state, flag);
  }

  function clearFlag(state, flag) {
    state.flags = state.flags.filter(function (item) { return item !== flag; });
    state.edges = state.edges.filter(function (edge) {
      return edge.indexOf("flag:" + flag + ":") !== 0 && edge.indexOf("endflag:" + flag + ":") !== 0;
    });
  }

  function reveal(state, id) {
    const sc = currentScenario(state);
    const comp = componentOf(sc, id);
    if (!comp) {
      state.fault = "В пакете нет компонента «" + id + "».";
      return;
    }
    if (state.revealed.includes(id)) return;
    state.revealed.push(id);
    state.pending.placed.push({ id: id, label: comp.label, kind: comp.kind });
  }

  function hide(state, id) {
    const sc = currentScenario(state);
    const comp = componentOf(sc, id);
    if (!comp) {
      state.fault = "В пакете нет компонента «" + id + "».";
      return;
    }
    if (!state.revealed.includes(id)) return;
    state.revealed = state.revealed.filter(function (item) { return item !== id; });
    state.pending.removed.push({ id: id, label: comp.label, kind: comp.kind });
  }

  function applyEffects(state, effects) {
    let endId = null;
    const goIds = [];
    (effects || []).forEach(function (eff) {
      if (state.fault) return;
      const key = Object.keys(eff)[0];
      if (key === "reveal") reveal(state, eff.reveal);
      else if (key === "hide") hide(state, eff.hide);
      else if (key === "set_flag") setFlag(state, eff.set_flag);
      else if (key === "clear_flag") clearFlag(state, eff.clear_flag);
      else if (key === "add_clock") addClock(state, eff.add_clock);
      else if (key === "go") goIds.push(eff.go);
      else if (key === "end") endId = eff.end;
    });
    if (endId) state.queue = [{ kind: "ending", id: endId }];
    else {
      for (let i = goIds.length - 1; i >= 0; i--) state.queue.unshift({ kind: "event", id: goIds[i] });
    }
  }

  function isSilent(event) {
    return event.read_aloud.trim() === "" && (!event.choices || event.choices.length === 0) && event.effects && event.effects.length > 0;
  }

  function pump(state) {
    let guard = 0;
    while (state.queue.length && guard++ < 40) {
      if (state.fault) return;
      const item = state.queue[0];
      if (item.kind === "ending") {
        state.queue.shift();
        show(state, { kind: "ending", id: item.id });
        return;
      }
      const sc = currentScenario(state);
      const event = sc && sc.events.find(function (entry) { return entry.id === item.id; });
      if (!event) {
        state.queue.shift();
        state.fault = "Пакет ссылается на событие «" + item.id + "», которого нет.";
        return;
      }
      if (isSilent(event)) {
        state.queue.shift();
        applyEffects(state, event.effects || []);
        continue;
      }
      state.queue.shift();
      show(state, { kind: "event", id: event.id });
      return;
    }
    if (guard >= 40) {
      state.fault = "Немые события зациклились. В пакете нет выхода, партия останавливается.";
      return;
    }
    settle(state);
  }

  function requirePlay(state) {
    if (state.mode !== "play" || !currentScenario(state)) return "Сценарий ещё не начат.";
    if (state.fault) return "Партия остановилась из-за пакета. Отмените шаг или откройте снимок.";
    return "";
  }

  function requireClear(state) {
    if (state.step) return "Сначала закройте текущий шаг.";
    return "";
  }

  function act(state, action) {
    if (!state || !action || !action.type) return fail(state, "Нет действия.");
    if (action.type === "undo") {
      if (!state.undo.length) return fail(state, "Отменять нечего.");
      const snap = clone(state.undo[state.undo.length - 1]);
      snap.package = state.package;
      snap.undo = state.undo.slice(0, -1);
      return { ok: true, state: snap };
    }
    const next = work(state);
    next.banner = null;

    if (action.type === "set_names") {
      if (next.mode === "play") return fail(state, "Имена фиксируются до обстановки. Сейчас уже партия.");
      const named = normalizeNames(action.names);
      if (!named.ok) return fail(state, named.error);
      next.names = named.names;
      return commit(state, next);
    }

    if (action.type === "begin_scenario") {
      if (next.mode === "over" || next.next === "stop") return fail(state, "Кампания закрыта.");
      if (next.mode !== "gate" && next.mode !== "between") return fail(state, "Сценарий уже идёт. Сначала финал.");
      const allowed = availableScenarios(next);
      if (!allowed.includes(action.scenario_id)) {
        return fail(state, "Этот сценарий сейчас не открыть. Партия предлагает следующий из тетради.");
      }
      const sc = scenarioById(next.package, action.scenario_id);
      if (!sc) return fail(state, "Сценария нет в ревизии.");
      if (next.names.length < sc.investigators.min || next.names.length > sc.investigators.max) {
        return fail(state, "В этом сценарии за столом от " + sc.investigators.min + " до " + sc.investigators.max + ".");
      }
      next.mode = "play";
      next.scenario_id = sc.id;
      next.revealed = sc.setup.present.slice();
      next.clock = sc.clock.start;
      next.opening_done = false;
      next.round = 1;
      next.last_phase = null;
      next.bump_round = false;
      next.step = { kind: "setup", placed: [], removed: [] };
      next.queue = [];
      next.pending = { placed: [], removed: [] };
      next.banner = null;
      next.fault = null;
      next.edges = [];
      next.previous_note = "";
      return commit(state, next);
    }

    const blocked = requirePlay(next);
    if (blocked) return fail(state, blocked);

    if (action.type === "confirm_setup") {
      if (!next.step || next.step.kind !== "setup") return fail(state, "Обстановка уже принята.");
      const sc = currentScenario(next);
      rememberNote(next);
      next.step = null;
      sc.events.forEach(function (event) {
        if (event.when.on === "session_start") enqueue(next, { kind: "event", id: event.id });
      });
      queueClockValue(next, next.clock);
      next.flags.slice().forEach(function (flag) { queueFlagTriggers(next, flag); });
      pump(next);
      return commit(state, next);
    }

    if (action.type === "choice") {
      if (!next.step || next.step.kind !== "event") return fail(state, "Сейчас нет выбора.");
      const event = currentScenario(next).events.find(function (item) { return item.id === next.step.id; });
      const choice = event && event.choices && event.choices[action.index];
      if (!choice) return fail(state, "Такого выбора в этом шаге нет.");
      rememberNote(next);
      next.step = null;
      applyEffects(next, choice.effects || []);
      pump(next);
      return commit(state, next);
    }

    if (action.type === "acknowledge") {
      if (!next.step || next.step.kind !== "event") return fail(state, "Сейчас нечего подтверждать.");
      const event = currentScenario(next).events.find(function (item) { return item.id === next.step.id; });
      if (event.choices && event.choices.length) return fail(state, "Здесь нужен выбор стола, не кнопка «прочитано».");
      rememberNote(next);
      next.step = null;
      applyEffects(next, event.effects || []);
      pump(next);
      return commit(state, next);
    }

    if (action.type === "dismiss") {
      if (!next.step || next.step.kind !== "empty") return fail(state, "Сейчас нечего закрывать.");
      next.step = null;
      next.banner = null;
      if (next.bump_round) {
        next.round += 1;
        next.bump_round = false;
      }
      return commit(state, next);
    }

    if (action.type === "record_ending") {
      if (!next.step || next.step.kind !== "ending") return fail(state, "Сейчас не финал.");
      const sc = currentScenario(next);
      const ending = sc.endings.find(function (item) { return item.id === next.step.id; });
      if (!ending) return fail(state, "Финал не найден в пакете.");
      ending.set_flags.forEach(function (flag) {
        if (!next.flags.includes(flag)) next.flags.push(flag);
      });
      if (!next.closed.includes(sc.id)) next.closed.push(sc.id);
      next.next = ending.next;
      next.mode = ending.next === "stop" ? "over" : "between";
      next.scenario_id = null;
      next.step = null;
      next.queue = [];
      next.revealed = [];
      next.opening_done = false;
      next.bump_round = false;
      next.banner = null;
      next.pending = { placed: [], removed: [] };
      next.edges = [];
      return commit(state, next);
    }

    const busy = requireClear(next);
    if (busy) return fail(state, busy);

    if (action.type === "phase") {
      if (!PHASES.includes(action.phase)) return fail(state, "Такой фазы нет.");
      if (!next.opening_done && action.phase !== "opening") return fail(state, "Сначала открытие.");
      if (action.phase === "opening" && next.opening_done) return fail(state, "Открытие уже было.");
      const sc = currentScenario(next);
      if (action.phase === "opening") next.opening_done = true;
      if (action.phase === "pressure") addClock(next, 1);
      if (action.phase === "creatures") next.bump_round = true;
      next.last_phase = action.phase;
      const matched = sc.events.filter(function (event) {
        return event.when.on === "phase" && event.when.phase === action.phase;
      });
      matched.forEach(function (event) { enqueue(next, { kind: "event", id: event.id }); });
      if (!next.queue.length) {
        show(next, { kind: "empty", phase: action.phase });
        return commit(state, next);
      }
      pump(next);
      return commit(state, next);
    }

    if (action.type === "marker" || action.type === "creature_down" || action.type === "host_call") {
      if (!next.opening_done) return fail(state, "Сначала открытие.");
      const sc = currentScenario(next);
      let matched = [];
      if (action.type === "marker") {
        const comp = componentOf(sc, action.component);
        if (!comp || comp.kind !== "marker") return fail(state, "Это не жетон этого сценария.");
        if (!next.revealed.includes(comp.id)) return fail(state, "Этого жетона ещё нет на столе.");
        matched = sc.events.filter(function (event) {
          return event.when.on === "marker_used" && event.when.component === comp.id;
        });
      } else if (action.type === "creature_down") {
        const comp = componentOf(sc, action.component);
        if (!comp || comp.kind !== "creature") return fail(state, "Это не существо этого сценария.");
        if (!next.revealed.includes(comp.id)) return fail(state, "Этого существа нет на столе.");
        matched = sc.events.filter(function (event) {
          return event.when.on === "creature_down" && event.when.component === comp.id;
        });
      } else {
        matched = sc.events.filter(function (event) {
          return event.when.on === "host_calls" && event.when.call === action.call;
        });
        if (!matched.length) return fail(state, "Такого такта в этом сценарии нет.");
      }
      if (!matched.length) {
        show(next, { kind: "empty", phase: action.type, placed: [], removed: [] });
        return commit(state, next);
      }
      matched.forEach(function (event) { enqueue(next, { kind: "event", id: event.id }); });
      pump(next);
      return commit(state, next);
    }

    return fail(state, "Такого действия партия не умеет.");
  }

  function joinNames(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + " и " + names[1];
    return names.slice(0, -1).join(", ") + " и " + names[names.length - 1];
  }

  function substitute(text, state, sc) {
    const source = String(text || "");
    const revealed = new Set(state && state.revealed || []);
    return source.replace(TOKEN_RE, function (token, body) {
      if (body === "investigators") return String(state && state.names ? state.names.length : "");
      if (body === "names") return state && state.names ? joinNames(state.names) : "";
      if (body === "clock") return String(state ? state.clock : "");
      if (body === "clock_name") return sc && sc.clock ? sc.clock.name : "";
      if (body.indexOf("component:") === 0) {
        const id = body.slice("component:".length);
        if (!revealed.has(id) || !sc) return "…";
        const comp = componentOf(sc, id);
        return comp ? comp.label : "…";
      }
      return token;
    });
  }

  function presentation(state) {
    if (!state) return { kind: "none" };
    const sc = currentScenario(state);
    const ctx = function (text) { return substitute(text, state, sc); };
    const base = {
      kind: state.mode,
      previous_note: ctx(state.previous_note || "").trim(),
      placed: [],
      removed: [],
      choices: [],
      read_aloud: "",
      host_note: "",
    };
    if (state.mode !== "play" || !sc) return base;
    if (state.fault) {
      base.kind = "fault";
      base.host_note = state.fault;
      return base;
    }
    const step = state.step;
    if (step && step.kind === "setup") {
      base.kind = "setup";
      base.read_aloud = ctx(sc.setup.read_aloud).trim();
      base.host_note = ctx(sc.setup.host_note).trim();
      base.placed = sc.setup.present.map(function (id) {
        const comp = componentOf(sc, id);
        return { id: id, label: comp ? comp.label : id, kind: comp ? comp.kind : "object", initial: true };
      });
      return base;
    }
    if (step && step.kind === "event") {
      const event = sc.events.find(function (item) { return item.id === step.id; });
      base.kind = "event";
      base.read_aloud = event ? ctx(event.read_aloud).trim() : "";
      base.host_note = event ? ctx(event.host_note).trim() : "";
      base.choices = event && event.choices ? event.choices.map(function (choice, index) {
        return { index: index, label: ctx(choice.label) };
      }) : [];
      base.needs_ack = !base.choices.length;
      base.placed = step.placed || [];
      base.removed = step.removed || [];
      return base;
    }
    if (step && step.kind === "ending") {
      const ending = sc.endings.find(function (item) { return item.id === step.id; });
      base.kind = "ending";
      base.ending_kind = ending ? ending.kind : "other";
      base.read_aloud = ending ? ctx(ending.read_aloud).trim() : "";
      base.host_note = ending ? ctx(ending.host_note).trim() : "";
      base.placed = step.placed || [];
      base.removed = step.removed || [];
      base.next = ending ? ending.next : "stop";
      base.set_flags = ending ? ending.set_flags.slice() : [];
      return base;
    }
    if (step && step.kind === "empty") {
      base.kind = "empty";
      base.phase = step.phase;
      base.placed = step.placed || [];
      base.removed = step.removed || [];
      return base;
    }
    base.kind = "round";
    base.host_note = ctx(state.previous_note || "").trim();
    base.placed = state.banner ? state.banner.placed : [];
    base.removed = state.banner ? state.banner.removed : [];
    return base;
  }

  function activeFlags(state) {
    const order = state.package.campaign.flags;
    return order.filter(function (flag) { return state.flags.includes(flag); });
  }

  function seal(pkg, savedAt) {
    const errors = validate(pkg);
    if (errors.length) return { ok: false, errors: errors };
    const id = identify(pkg);
    return {
      ok: true,
      revision: {
        format: "orbis-revision/1",
        revision_id: id.revision_id,
        fingerprint: id.fingerprint,
        saved_at: savedAt || new Date().toISOString(),
        package: clone(pkg),
      },
    };
  }

  function openRevision(data) {
    if (!isObject(data)) return { ok: false, error: "Файл не похож на ревизию Orbis." };
    if (data.format === "orbis-session/1") return { ok: false, error: "Это снимок партии. Откройте его кнопкой снимка, не как ревизию." };
    if (data.format === "orbis/1") return { ok: false, error: "Это пакет, а не готовая ревизия. Отметьте его в приёме данных." };
    if (data.format !== "orbis-revision/1") return { ok: false, error: "Файл не похож на ревизию Orbis." };
    const errors = validate(data.package);
    if (errors.length) return { ok: false, error: "Ревизия не проходит проверку.", errors: errors };
    const id = identify(data.package);
    if (id.fingerprint !== data.fingerprint) {
      return { ok: false, error: "Отпечаток в файле не совпал с содержимым. Ревизия повреждена или переписана." };
    }
    return {
      ok: true,
      revision: {
        format: "orbis-revision/1",
        revision_id: id.revision_id,
        fingerprint: id.fingerprint,
        saved_at: data.saved_at || "",
        package: data.package,
      },
    };
  }

  function exportSession(state, savedAt) {
    const play = bare(state);
    play.undo = state.undo.map(function (snap) {
      const copy = clone(snap);
      delete copy.package;
      copy.undo = [];
      return copy;
    });
    play.fingerprint = state.fingerprint;
    play.revision_id = state.revision_id;
    return {
      format: "orbis-session/1",
      revision_id: state.revision_id,
      fingerprint: state.fingerprint,
      saved_at: savedAt || new Date().toISOString(),
      package: state.package,
      play: play,
    };
  }

  function sanity(state) {
    const modes = ["gate", "play", "between", "over"];
    if (!modes.includes(state.mode)) return { ok: false, error: "Снимок говорит о режиме, которого партия не знает." };
    if (!Array.isArray(state.names) || state.names.some(function (name) { return typeof name !== "string" || !name.trim(); })) {
      return { ok: false, error: "В снимке нет имён сыщиков." };
    }
    const knownFlags = new Set(state.package.campaign.flags);
    if (!Array.isArray(state.flags) || state.flags.some(function (flag) { return !knownFlags.has(flag); })) {
      return { ok: false, error: "В снимке флаг, которого нет в тетради ревизии." };
    }
    if (state.next !== "stop" && state.next && !scenarioById(state.package, state.next)) {
      return { ok: false, error: "Снимок ведёт в сценарий, которого в ревизии нет." };
    }
    if (state.mode === "play") {
      const sc = currentScenario(state);
      if (!sc) return { ok: false, error: "Снимок обрывается на сценарии, которого нет в ревизии." };
      const ids = new Set(sc.components.map(function (comp) { return comp.id; }));
      if (!Array.isArray(state.revealed) || state.revealed.some(function (id) { return !ids.has(id); })) {
        return { ok: false, error: "Снимок держит на столе компонент, которого нет в сценарии." };
      }
      if (state.step && state.step.kind === "event" && !sc.events.some(function (event) { return event.id === state.step.id; })) {
        return { ok: false, error: "Снимок стоит на событии, которого нет в ревизии." };
      }
      if (state.step && state.step.kind === "ending" && !sc.endings.some(function (ending) { return ending.id === state.step.id; })) {
        return { ok: false, error: "Снимок стоит на финале, которого нет в ревизии." };
      }
    }
    return { ok: true };
  }

  function importSession(data) {
    if (!isObject(data) || data.format !== "orbis-session/1") return { ok: false, error: "Это не снимок партии Orbis." };
    const errors = validate(data.package);
    if (errors.length) return { ok: false, error: "Пакет внутри снимка не проходит проверку.", errors: errors };
    const id = identify(data.package);
    if (id.fingerprint !== data.fingerprint) {
      return { ok: false, error: "Отпечаток снимка не совпал с пакетом. Вечер записан от другой ревизии." };
    }
    if (!isObject(data.play)) return { ok: false, error: "В снимке нет состояния вечера." };
    if (data.play.fingerprint && data.play.fingerprint !== id.fingerprint) {
      return { ok: false, error: "Снимок собран от другого отпечатка." };
    }
    const state = clone(data.play);
    state.package = clone(data.package);
    state.revision_id = id.revision_id;
    state.fingerprint = id.fingerprint;
    state.undo = Array.isArray(data.play.undo) ? data.play.undo.map(function (snap) {
      const copy = clone(snap);
      delete copy.package;
      copy.undo = [];
      return copy;
    }) : [];
    if (!state.pending) state.pending = { placed: [], removed: [] };
    if (!Array.isArray(state.edges)) state.edges = [];
    if (!Array.isArray(state.queue)) state.queue = [];
    const check = sanity(state);
    if (!check.ok) return check;
    return { ok: true, state: state };
  }

  return {
    PHASES: PHASES,
    EFFECT_KEYS: EFFECT_KEYS,
    parseSource: parseSource,
    validate: validate,
    identify: identify,
    normalizeNames: normalizeNames,
    createSession: createSession,
    act: act,
    presentation: presentation,
    availableScenarios: availableScenarios,
    activeFlags: activeFlags,
    substitute: substitute,
    seal: seal,
    openRevision: openRevision,
    exportSession: exportSession,
    importSession: importSession,
    scenarioById: scenarioById,
  };
});
