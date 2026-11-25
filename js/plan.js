// Daily Planner: the "brain". Works out today's plan from the saved data.
//
// Everything here is a PURE function: you give it the data (from store.get())
// and today's date ("YYYY-MM-DD"), it gives back a plan. It never reads or
// saves anything itself and never looks at the clock, which makes it easy
// to test: same input, same output, every time.
//
// Main entry point:   PlannerLogic.planDay(data, "2026-11-25", { lowEnergy: false })
//
// Every suggestion carries a short `reason` in plain English, so the app can
// show WHY it suggests something.
//
// Works in the browser (as window.PlannerLogic) and in Node (for tests).
"use strict";

(function (root) {
  const P = typeof module !== "undefined" && module.exports ? require("./store.js") : root.PlannerData;

  // ---------- settings (easy to tweak) ----------
  // Study block length and the weekly training targets are NOT here: they
  // are saved in the data (data.settings) and edited on the Settings screen.
  // Defaults: 45-min blocks; gym 3–4x/week; Push 2, Pull 2, Legs 1; 2 runs.
  const STUDY_BLOCKS_PER_DAY = 2;
  const STUDY_LOOKBACK_DAYS = 14;    // "recently studied" = the last 2 weeks
  const STUDY_NEGLECT_MIN = 300;     // 300 min studied recently halves a subject's pull
  const STUDY_FOCUS_DAYS = 3;        // exam this close: both blocks go to it
  const NO_EXAM_DATE_DAYS = 60;      // subject without exam date: treat as "60 days away"

  const EXAM_CAP_DAYS = 2;           // exam within 2 days: training stays light

  const RECOVERY_GREEN = 67;         // Whoop's own colour bands
  const RECOVERY_YELLOW = 34;
  const HRV_LOW_RATIO = 0.85;        // HRV 15 %+ below 7-day average = "well below"
  const HRV_OK_RATIO = 0.95;
  const RHR_HIGH_BPM = 5;            // resting HR 5+ bpm above average = stressed
  const BASELINE_DAYS = 7;
  const BASELINE_MIN_VALUES = 3;     // need at least 3 days to call it an average

  const MIN_SETS = 3;

  const GROUPS = ["push", "pull", "legs"];
  const GROUP_NAME = { push: "Push", pull: "Pull", legs: "Legs" };
  const GROUP_DETAIL = { push: "chest, triceps, shoulders", pull: "back, biceps", legs: "legs" };

  // The weekly targets from the saved settings (defaults if not set).
  function targetsFrom(settings) {
    const s = Object.assign({}, P.DEFAULT_SETTINGS, settings || {});
    return {
      week: { push: s.push, pull: s.pull, legs: s.legs },
      minSets: MIN_SETS, gymMin: s.gymMin, gymMax: s.gymMax,
      cardio: s.runs,                // runs + football
    };
  }

  // ---------- date helpers ----------
  // Dates are "YYYY-MM-DD". We count in whole days using UTC so that
  // daylight-saving changes can never make a day 23 or 25 hours long.
  function dayNum(s) {
    const [y, m, d] = s.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  const daysBetween = (from, to) => dayNum(to) - dayNum(from);
  const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
  // 0 = Monday ... 6 = Sunday
  const weekday = (s) => (new Date(dayNum(s) * 86400000).getUTCDay() + 6) % 7;
  const weekStart = (s) => addDays(s, -weekday(s));

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const round = (x, n) => Math.round(x * Math.pow(10, n || 0)) / Math.pow(10, n || 0);
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  function shortDate(s) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [, m, d] = s.split("-").map(Number);
    return d + " " + months[m - 1];
  }

  // =====================================================================
  // 1. EXAMS AND STUDY
  // =====================================================================

  // Days left until each exam, closest first. Subjects without a date go last.
  function examCountdown(subjects, today) {
    return subjects
      .map((s) => {
        const daysLeft = s.examDate ? daysBetween(today, s.examDate) : null;
        let label;
        if (daysLeft === null) label = "No exam date yet";
        else if (daysLeft < 0) label = "Exam done";
        else if (daysLeft === 0) label = "Exam today";
        else if (daysLeft === 1) label = "Exam tomorrow";
        else label = daysLeft + " days left";
        return {
          subjectId: s.id, name: s.name, examDate: s.examDate,
          confirmed: !!s.examDateConfirmed, daysLeft, label,
        };
      })
      .sort((a, b) => {
        const A = a.daysLeft === null ? Infinity : a.daysLeft < 0 ? 1e9 + a.daysLeft : a.daysLeft;
        const B = b.daysLeft === null ? Infinity : b.daysLeft < 0 ? 1e9 + b.daysLeft : b.daysLeft;
        return A - B;
      });
  }

  // The nearest exam that hasn't happened yet (or null).
  function nextExam(subjects, today) {
    return examCountdown(subjects, today).find((e) => e.daysLeft !== null && e.daysLeft >= 0) || null;
  }

  // How "pressing" each subject is today.
  //   urgency: closer exam = much more urgent (1 / days², so 10 days away is
  //            4x as pressing as 20 days away)
  //   neglect: little studied in the last 2 weeks = more pressing
  // score = urgency x neglect. Highest score gets studied first.
  // Only sessions BEFORE today count, so the plan doesn't jump around after
  // you log your first block of the day.
  function studyScores(data, today) {
    const from = addDays(today, -STUDY_LOOKBACK_DAYS);
    const recent = {};
    for (const s of data.studySessions) {
      if (s.date >= from && s.date < today) recent[s.subjectId] = (recent[s.subjectId] || 0) + s.minutes;
    }
    return examCountdown(data.subjects, today)
      .filter((e) => e.daysLeft === null || e.daysLeft >= 0)
      .map((e) => {
        const days = Math.max(e.daysLeft === null ? NO_EXAM_DATE_DAYS : e.daysLeft, 1);
        const minutes = recent[e.subjectId] || 0;
        const urgency = 1 / (days * days);
        const neglect = 1 / (1 + minutes / STUDY_NEGLECT_MIN);
        return Object.assign({}, e, { recentMinutes: minutes, score: urgency * neglect });
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function studyReason(e, focus) {
    let when;
    if (e.daysLeft === null) when = "No exam date set";
    else if (e.daysLeft === 0) when = "Exam is today: quick review only";
    else if (e.daysLeft === 1) when = "Exam tomorrow (" + shortDate(e.examDate) + ")";
    else when = "Exam in " + e.daysLeft + " days (" + shortDate(e.examDate) + (e.confirmed ? "" : ", date not final") + ")";
    const studied = e.recentMinutes === 0
      ? "nothing logged in the last 2 weeks"
      : e.recentMinutes + " min studied in the last 2 weeks";
    return when + "; " + studied + (focus ? ". Closest exam, so both blocks go here." : ".");
  }

  // Suggests today's study blocks (2 normally, 1 in low energy mode).
  function suggestStudy(data, today, options) {
    const count = (options && options.blocks) || STUDY_BLOCKS_PER_DAY;
    const ranked = studyScores(data, today);
    if (ranked.length === 0) {
      return { blocks: [], reason: "No upcoming exams. Nothing to study for." };
    }
    const top = ranked[0];
    const focus = count > 1 && top.daysLeft !== null && top.daysLeft <= STUDY_FOCUS_DAYS;
    const picks = [];
    for (let i = 0; i < count; i++) {
      // Normally a different subject per block; same subject if the exam is
      // very close or if only one subject is left.
      picks.push(focus ? top : ranked[Math.min(i, ranked.length - 1)]);
    }
    const blocks = picks.map((e, i) => ({
      key: "study:" + e.subjectId + ":" + (i + 1),
      subjectId: e.subjectId,
      subjectName: e.name,
      minutes: P.settingsOf(data).studyBlockMin,
      daysLeft: e.daysLeft,
      reason: studyReason(e, focus),
    }));
    return { blocks, reason: "Picked by how close the exam is and how little you studied it lately." };
  }

  // =====================================================================
  // 2. CHORES
  // =====================================================================

  // Status of one chore today:
  //   "never"    – never logged as done
  //   "not-due"  – done recently (fewer than minDays ago)
  //   "due-soon" – minDays to maxDays since last done: do it when you can
  //   "overdue"  – more than maxDays since last done
  //   "done-today"
  function choreStatus(chore, today) {
    if (!chore.lastDone) {
      return { status: "never", daysSince: null, label: "Not logged yet" };
    }
    const daysSince = Math.max(0, daysBetween(chore.lastDone, today)); // future date (clock wrong) = 0
    if (chore.lastDone >= today) return { status: "done-today", daysSince: 0, label: "Done today" };
    let status, label;
    if (daysSince > chore.maxDays) {
      status = "overdue";
      label = plural(daysSince - chore.maxDays, "day") + " overdue";
    } else if (daysSince >= chore.minDays) {
      status = "due-soon";
      label = chore.maxDays === daysSince ? "Due today" : "Due within " + plural(chore.maxDays - daysSince, "day");
    } else {
      status = "not-due";
      label = "Next in " + plural(chore.minDays - daysSince, "day");
    }
    return { status, daysSince, label };
  }

  function allChoreStatuses(chores, today) {
    return chores.map((c) => Object.assign({ choreId: c.id, name: c.name, minDays: c.minDays, maxDays: c.maxDays, daily: c.maxDays === 1 }, choreStatus(c, today)));
  }

  function choreReason(c) {
    const every = c.minDays === c.maxDays ? "every " + plural(c.maxDays, "day") : "every " + c.minDays + "–" + c.maxDays + " days";
    if (c.status === "done-today") return "Already done today.";
    if (c.status === "never") return "Not logged yet (" + every + "). Do it once so the app can start tracking it.";
    if (c.daily) return "Daily chore.";
    const ago = "Last done " + plural(c.daysSince, "day") + " ago (" + every + ")";
    return c.status === "overdue" ? ago + ": overdue." : ago + ": due now.";
  }

  // Suggests today's chores:
  //   - daily chores (dishes) always
  //   - plus 1 other chore that is due; a 2nd only if it is overdue too
  //     (so chores pile up less, but don't eat a whole study day)
  // Order: most overdue first, measured as "days since / max days", so a
  // chore at 2x its limit beats one just over it.
  // A non-daily chore already done today counts as today's chore.
  function suggestChores(data, today, options) {
    const lowEnergy = options && options.lowEnergy;
    const all = allChoreStatuses(data.chores, today);
    const daily = all.filter((c) => c.daily);
    const others = all.filter((c) => !c.daily);

    const rank = (c) => {
      if (c.status === "overdue") return 3000 + c.daysSince / c.maxDays;
      if (c.status === "due-soon") return 2000 + c.daysSince / c.maxDays;
      if (c.status === "never") return 1000 - c.maxDays; // most frequent first
      return 0;
    };
    const doneToday = others.filter((c) => c.status === "done-today");
    const candidates = others.filter((c) => rank(c) > 0).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));

    let picks = [];
    if (!lowEnergy) {
      picks = doneToday.slice(0, 2);
      for (const c of candidates) {
        if (picks.length >= 2) break;
        if (picks.length === 0 || c.status === "overdue") picks.push(c);
      }
    }
    const list = daily.concat(picks).map((c) => ({
      key: "chore:" + c.choreId,
      choreId: c.choreId,
      name: c.name,
      status: c.status,
      done: c.status === "done-today",
      reason: choreReason(c),
    }));
    let reason;
    if (lowEnergy) reason = "Low energy mode: just the daily chore.";
    else if (picks.length === 0) reason = "Nothing else is due. Enjoy it.";
    else reason = "Most overdue first; at most 2 besides the dishes.";
    return { chores: list, all, reason };
  }

  // =====================================================================
  // 3. TRAINING
  // =====================================================================

  // Recovery zone from today's Whoop numbers, compared with the 7 days before.
  // Returns { zone: "green" | "yellow" | "red" | null, reasons: [...] }.
  // zone null = not enough data to judge.
  function assessRecovery(metrics, today) {
    const m = metrics[today] || null;
    const prev = [];
    for (let i = 1; i <= BASELINE_DAYS; i++) {
      const x = metrics[addDays(today, -i)];
      if (x) prev.push(x);
    }
    const avg = (k) => {
      const v = prev.map((x) => x[k]).filter(isNum);
      return v.length >= BASELINE_MIN_VALUES ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const hrvAvg = avg("hrv"), rhrAvg = avg("rhr");
    const out = { zone: null, reasons: [], today: m, hrvAvg, rhrAvg };
    if (!m) { out.reasons.push("No Whoop data for today"); return out; }

    let zone = null;
    if (isNum(m.recovery)) {
      zone = m.recovery >= RECOVERY_GREEN ? "green" : m.recovery >= RECOVERY_YELLOW ? "yellow" : "red";
      out.reasons.push("Recovery " + m.recovery + "% (" + zone + ")");
    }
    if (isNum(m.hrv) && hrvAvg !== null) {
      const ratio = m.hrv / hrvAvg;
      if (ratio < HRV_LOW_RATIO) {
        zone = "red";
        out.reasons.push("HRV " + m.hrv + " ms is " + Math.round((1 - ratio) * 100) + "% below your 7-day average (" + round(hrvAvg) + " ms)");
      } else if (zone === null) {
        zone = ratio >= HRV_OK_RATIO ? "green" : "yellow";
        out.reasons.push("HRV " + m.hrv + " ms vs 7-day average " + round(hrvAvg) + " ms");
      }
    }
    if (isNum(m.rhr) && rhrAvg !== null) {
      const up = m.rhr - rhrAvg;
      if (up >= RHR_HIGH_BPM) {
        const before = zone;
        zone = zone === "green" ? "yellow" : zone === null ? "yellow" : "red";
        out.reasons.push("resting HR " + m.rhr + " is " + round(up) + " bpm above average" +
          (before && before !== zone ? " (so " + before + " → " + zone + ")" : ""));
      } else if (zone === null) {
        out.reasons.push("resting HR " + m.rhr + " is normal, but that alone isn't enough to judge");
      }
    }
    if (zone === null && out.reasons.length === 0) out.reasons.push("Not enough Whoop history to compare with (needs 3+ days)");
    out.zone = zone;
    return out;
  }

  // A gym session counts for a group if the group was trained with at least
  // 3 sets (or the sets weren't logged: benefit of the doubt).
  function countsFor(t, g) {
    if (!t.groups || !t.groups.includes(g)) return false;
    if (!t.sets || !isNum(t.sets[g])) return true;
    return t.sets[g] >= MIN_SETS;
  }

  // What's done this week (Monday to yesterday; today's logs are handled separately).
  // `settings` = data.settings (leave out for the defaults).
  function weeklyProgress(training, today, settings) {
    const T = targetsFrom(settings);
    const start = weekStart(today);
    const week = training.filter((t) => t.date >= start && t.date < today);
    const gym = week.filter((t) => t.type === "gym");
    const groups = {}, deficits = {}, lastTrained = {};
    for (const g of GROUPS) {
      groups[g] = gym.filter((t) => countsFor(t, g)).length;
      deficits[g] = Math.max(0, T.week[g] - groups[g]);
      const all = training.filter((t) => t.type === "gym" && t.date < today && countsFor(t, g)).map((t) => t.date).sort();
      lastTrained[g] = all.length ? all[all.length - 1] : null;
    }
    const runs = week.filter((t) => t.type === "run").length;
    const football = week.filter((t) => t.type === "football").length;
    const gymSessions = gym.length;
    const groupsMet = GROUPS.every((g) => deficits[g] === 0);
    return {
      weekStart: start, targets: T,
      gymSessions, groups, deficits, lastTrained, runs, football,
      cardio: runs + football,
      daysLeftInWeek: 7 - weekday(today), // including today
      gymMet: gymSessions >= T.gymMin && groupsMet,
      gymMaxed: gymSessions >= T.gymMax,
      cardioMet: runs + football >= T.cardio,
    };
  }

  function weekSummary(wp) {
    const T = wp.targets;
    return "This week: " + GROUPS.map((g) => GROUP_NAME[g] + " " + wp.groups[g] + "/" + T.week[g]).join(", ") +
      "; gym " + wp.gymSessions + " of " + T.gymMin + "–" + T.gymMax + "; cardio " + wp.cardio + "/" + T.cardio + ".";
  }

  // Which muscle group(s) to train today.
  // Furthest behind first; ties go to the group trained longest ago.
  // If there are more group-sessions still needed than gym days left
  // (max 4 sessions, days left in the week), groups are combined
  // (e.g. Upper body = Push + Pull, or Full body).
  function pickGymFocus(wp) {
    const behind = GROUPS.filter((g) => wp.deficits[g] > 0).sort((a, b) =>
      wp.deficits[b] - wp.deficits[a] ||
      (wp.lastTrained[a] || "") .localeCompare(wp.lastTrained[b] || "") ||
      GROUPS.indexOf(a) - GROUPS.indexOf(b));
    if (behind.length === 0) {
      // All groups hit, but under 3 sessions: train what's been rested longest.
      const oldest = GROUPS.slice().sort((a, b) => (wp.lastTrained[a] || "").localeCompare(wp.lastTrained[b] || ""))[0];
      return { groups: [oldest], why: "All groups have hit their target; one more session gets you to " + wp.targets.gymMin + ". " + GROUP_NAME[oldest] + " has rested longest." };
    }
    const needed = behind.reduce((s, g) => s + wp.deficits[g], 0);
    const slots = Math.max(1, Math.min(wp.targets.gymMax - wp.gymSessions, wp.daysLeftInWeek));
    const n = Math.min(behind.length, Math.ceil(needed / slots));
    const groups = behind.slice(0, n).sort((a, b) => GROUPS.indexOf(a) - GROUPS.indexOf(b));
    let why = GROUP_NAME[behind[0]] + " is furthest behind";
    if (n > 1) why += "; " + needed + " group-sessions still needed with " + plural(slots, "gym session") + " left, so combine";
    return { groups, why: why + "." };
  }

  function focusLabel(groups) {
    if (groups.length === 3) return "Full body";
    if (groups.length === 2 && groups.includes("push") && groups.includes("pull")) return "Upper body (Push + Pull)";
    if (groups.length === 1) return GROUP_NAME[groups[0]] + " (" + GROUP_DETAIL[groups[0]] + ")";
    return groups.map((g) => GROUP_NAME[g]).join(" + ");
  }

  function gymSuggestion(wp, lead) {
    const f = pickGymFocus(wp);
    return {
      type: "gym",
      key: "training:gym",
      focus: f.groups,
      label: "Gym: " + focusLabel(f.groups),
      detail: "At least " + MIN_SETS + " sets per muscle group.",
      reason: lead + " " + f.why + " " + weekSummary(wp),
    };
  }

  const easyRun = (reason, label) => ({
    type: "run", key: "training:run", focus: [],
    label: label || "Easy zone-2 run",
    detail: "30–40 min at a pace where you could still talk.",
    reason,
  });

  const rest = (reason, label) => ({
    type: "rest", key: "training:rest", focus: [],
    label: label || "Rest or easy walk",
    detail: "A 20–30 min walk is fine; no hard training.",
    reason,
  });

  // When the body says "go": gym if the weekly gym target isn't met yet,
  // otherwise a run.
  function goodDay(wp, lead) {
    if (!wp.gymMet && !wp.gymMaxed) return gymSuggestion(wp, lead);
    const why = wp.gymMaxed ? "Already " + wp.targets.gymMax + " gym sessions this week (the max)" : "Weekly gym target met";
    if (!wp.cardioMet) return easyRun(lead + " " + why + ", so a run instead. " + weekSummary(wp), "Run");
    return easyRun(lead + " " + why + " and cardio done too: an extra easy run if you feel like it, or rest. " + weekSummary(wp), "Optional easy run");
  }

  function suggestTraining(data, today, options) {
    const lowEnergy = options && options.lowEnergy;
    const wp = weeklyProgress(data.training, today, data.settings);
    const rec = assessRecovery(data.metrics, today);
    const exam = nextExam(data.subjects, today);
    const base = { recovery: rec, week: wp };
    const done = data.training.filter((t) => t.date === today);
    const lead = rec.reasons.join("; ") + ".";

    let s;
    if (done.length) {
      const what = done.map((t) => t.type === "gym" ? "gym (" + t.groups.map((g) => GROUP_NAME[g]).join(" + ") + ")" : t.type).join(", ");
      s = { type: "done", key: "training:done", focus: [], label: "Training done for today", detail: "", reason: "Already logged " + what + " today. Recover well." };
    } else if (lowEnergy) {
      s = rest("Low energy mode: an easy walk still keeps the habit going.");
    } else if (exam && exam.daysLeft <= EXAM_CAP_DAYS) {
      const when = exam.daysLeft === 0 ? "today" : exam.daysLeft === 1 ? "tomorrow" : "in " + exam.daysLeft + " days";
      s = rest(exam.name + " exam " + when + ": keep training light so you're fresh and can study.", "Rest or light walk");
    } else if (rec.zone === "red") {
      s = rest(lead + " Body needs recovery today.");
    } else if (rec.zone === "yellow") {
      s = easyRun(lead + " Medium recovery: easy cardio, no heavy lifting.");
    } else if (rec.zone === "green") {
      s = goodDay(wp, lead);
    } else {
      // No usable Whoop data: decide by the week's progress alone.
      const noData = rec.reasons.join("; ") + ", so going by your week.";
      if (!wp.gymMet && !wp.gymMaxed) s = gymSuggestion(wp, noData);
      else if (!wp.cardioMet) s = easyRun(noData + " Gym target met, cardio isn't. " + weekSummary(wp));
      else s = rest(noData + " Weekly targets are all met. " + weekSummary(wp));
    }
    return Object.assign(s, base);
  }

  // =====================================================================
  // 4. THE WHOLE DAY
  // =====================================================================

  // Low energy mode shrinks the plan to the minimum so nothing is skipped
  // completely: 1 study block, daily chore only, rest/walk.
  function planDay(data, today, options) {
    const lowEnergy = !!(options && options.lowEnergy);
    return {
      date: today,
      lowEnergy,
      exams: examCountdown(data.subjects, today),
      study: suggestStudy(data, today, { blocks: lowEnergy ? 1 : STUDY_BLOCKS_PER_DAY }),
      chores: suggestChores(data, today, { lowEnergy }),
      training: suggestTraining(data, today, { lowEnergy }),
    };
  }

  const api = {
    planDay, examCountdown, nextExam, studyScores, suggestStudy,
    choreStatus, suggestChores, assessRecovery, weeklyProgress, pickGymFocus, suggestTraining,
    // helpers, exposed for tests and for the Today screen (js/today.js)
    daysBetween, addDays, weekStart, countsFor, targetsFrom,
    TARGETS: targetsFrom(null), // the defaults; the real ones come from data.settings
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlannerLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
