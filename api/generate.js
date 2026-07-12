// --- Persistence (Supabase) ---------------------------------------
// Stores every intake + every generation (original and regenerations,
// with the feedback text that drove each regen) so this data can be
// reused later without re-collecting it from clients. Uses the
// service-role key server-side only — never exposed to the client,
// same pattern as ANTHROPIC_API_KEY below.
//
// All of this is best-effort: if the env vars aren't set yet, or a
// Supabase call fails for any reason, we log it and let the workout
// generation itself proceed exactly as it did before this was added.
// Nothing here should ever be able to break a client's experience.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_GENERATIONS = 4; // 1 original + up to 3 regenerations

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      console.error("Supabase error:", path, res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("Supabase request failed:", path, err.message);
    return null;
  }
}

async function createIntake(profile) {
  const rows = await supabaseRequest("workout_intakes", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([
      {
        first_name: profile?.firstName || "",
        email: profile?.email || "",
        gender: profile?.gender || null,
        level: profile?.level || null,
        goal: profile?.goal || null,
        equipment: profile?.equipment || null,
        days: profile?.days || null,
        cardio: profile?.cardio || null,
        injuries: profile?.injuries || null,
        notes: profile?.notes || null,
      },
    ]),
  });
  return rows?.[0]?.id || null;
}

async function nextGenerationNumber(intakeId) {
  const rows = await supabaseRequest(
    `workout_generations?intake_id=eq.${intakeId}&select=generation_number&order=generation_number.desc&limit=1`
  );
  const latest = rows?.[0]?.generation_number || 0;
  return latest + 1;
}

// Claude tends to write with em dashes (—) by default. Satish wants
// plans to read with plain single hyphens instead, so this is enforced
// two ways: an explicit instruction in CRITICAL OUTPUT RULES below
// (so the model tries to comply on its own), plus this guaranteed
// cleanup pass on whatever it actually returns, since prompt
// instructions alone aren't 100% reliable. Runs on every generation
// and regeneration.
function sanitizeDashes(text) {
  return text.replace(/[—–]/g, "-").replace(/-{2,}/g, "-");
}

async function saveGeneration(intakeId, generationNumber, feedback, markdown) {
  await supabaseRequest("workout_generations", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        intake_id: intakeId,
        generation_number: generationNumber,
        feedback_text: feedback || null,
        markdown,
      },
    ]),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { prompt, profile, intakeId: incomingIntakeId, feedback } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing required field: prompt" });
    }

    // Figure out whether this is the original generation or a
    // regeneration, and enforce the 3-regeneration cap server-side
    // (not just in the UI) so it can't be bypassed by calling the API
    // directly. If Supabase isn't configured, intakeId stays null and
    // this is skipped entirely — generation still works, just without
    // the cap or persistence.
    let intakeId = incomingIntakeId || null;
    let generationNumber = 1;

    if (intakeId) {
      generationNumber = await nextGenerationNumber(intakeId);
      if (generationNumber > MAX_GENERATIONS) {
        return res.status(429).json({
          error: "You've reached the limit of 3 regenerations for this plan.",
        });
      }
    } else {
      intakeId = await createIntake(profile);
      generationNumber = 1;
    }

    const skillContent = `---
name: workout-builder
description: Build personalized workout programs for clients based on their fitness level, goals, equipment access, and availability. Use this skill whenever a user asks to create a workout plan, design a training program, build a routine, or program exercises for a client. Trigger even if the request is casual (e.g. "make me a workout", "what should my client do this week", "build a beginner plan"). Covers beginner, intermediate, and athlete-level clients across strength training, cardio, HIIT, and rehab.
---

# Workout Builder Skill

This skill encodes a complete methodology for building personalized workout programs. Always gather key client information before building a program, then apply the appropriate methodology based on fitness level, goal, and equipment access.

---

## Step 1: Gather Client Information

Before building any program, collect:
- **Goal**: Weight loss, muscle gain, general fitness, rehab, performance?
- **Fitness level**: Absolute beginner, beginner, intermediate, athlete?
- **Equipment access**: No equipment (bodyweight only), home equipment (bands, dumbbells), or full gym?
- **Days available per week**: Default plan for 6 days, scale to 4-5 if that's all they can commit to
- **Any injuries or limitations?**
- **Client preferences**: Do they enjoy cardio? Strength training? Any splits they prefer?

---

## Step 2: Select the Right Program Path

### Fitness Level Definitions
- **Absolute Beginner**: Never trained before, or returning after a very long break
- **Beginner**: Some exposure to exercise, limited structured training
- **Intermediate**: 2+ months of consistent foundational training
- **Athlete**: Advanced, sport-specific, or performance-focused training

---

## SPLIT SELECTION FRAMEWORK

### Primary Driver: Client Preference + Goal

| Client Preference / Goal | Recommended Split |
|---|---|
| Loves strength, okay with some cardio | Push / Pull / Legs + HIIT (rolling 6-day) |
| Dislikes cardio entirely | Push / Pull / Legs (no dedicated cardio day) |
| Neutral on cardio, open to expanding | Push / Pull / Legs + 1 HIIT day |
| Enjoys cardio, happy to do HIIT | Upper / Lower / HIIT / Upper / Lower / HIIT |
| Limited days (3-4 days available) | Whole Body splits |
| Primary goal: muscle gain, no weight loss | Limit HIIT — focus on strength splits |
| Fat loss goal | Always retain cardio/HIIT — non-negotiable |

### Goal-Based Cardio Rules
- **Fat loss:** Always retain some form of cardio/HIIT — minimum 1 HIIT day per week
- If client refuses dedicated cardio day → embed HIIT finisher into Pull days (lowest intensity day)
- **Muscle gain:** Limit HIIT during gaining phase — too much interferes with recovery and muscle building

---

## WEEKLY MOVEMENT PATTERN CHECKLIST

**Must be covered across the full week regardless of split chosen:**

Upper Body:
- ✅ Horizontal Push
- ✅ Horizontal Pull
- ✅ Vertical Push
- ✅ Vertical Pull

Lower Body:
- ✅ Squat pattern
- ✅ Hinge pattern
- ✅ Lunge / Single-leg pattern (both quad-dominant AND hamstring-dominant across the week)

Optional (when time allows — not every day):
- ➕ Carry pattern (farmer's walks, loaded carries)

**Key Rule:** Movement patterns are a flexible guide within a single session, but a non-negotiable checklist across the full week. Always zoom out and verify the week as a whole covers every pattern.

---

## BEGINNER METHODOLOGY

### Guiding Principle
Build foundational movement patterns before adding load or intensity. Safety, joint health, and movement quality come first. Progress gradually and consistently.

---

### WEEK 1: Basic Prep Phase

**Structure:** Alternate between Basic Prep 1 and Low-Impact Cardio HIIT for the entire week. Basic Prep 1 is Week 1 only.

Example 6-day week:
- Mon: Basic Prep 1
- Tue: Low-Impact Cardio HIIT
- Wed: Basic Prep 1
- Thu: Low-Impact Cardio HIIT
- Fri: Basic Prep 1
- Sat: Low-Impact Cardio HIIT
- Sun: Rest

Scale to 4 or 5 days if client can't commit to 6.

---

#### Basic Prep 1 — Foundational Movement Patterns

**1. Core / Stability (Dead Bug Family)**
Introduce in this order of difficulty:
- Heel slides (easiest — refer to Girls Gone Strong YouTube)
- Supine marches
- Dead bugs
- Bird dogs:
  - Hand movement only
  - Leg movement only
  - Alternating hand + leg (most advanced)

**2. Squat Pattern**
- Start: Wall sits
- Progress to: Box squats
- Progress to: Full squats

**3. Push Pattern**
Progression ladder:
1. Wall push-ups
2. Knee push-ups
3. Eccentric knee push-ups
4. Incline push-ups
5. Eccentric floor push-ups
6. Full push-up

Progress week on week — don't rush.

**4. Hinge Pattern**
- Hip hinge with a stick (teaches spine neutrality — essential foundation for RDLs and deadlifts)
- Glute bridges (introduced early, a staple)

**5. Pull Pattern**
- Band rows (if bands available)
- Band pull-aparts (if bands available)
- TRX rows — hold off for later (equipment availability + steeper learning curve)
- If no bands: IYTWs (prone Y/T/W raises) as primary alternative
- Door frame rows — possible but harder learning curve, especially for heavier clients
- Avoid towel rows — injury risk
> **Note:** By end of Week 2, encourage clients to invest in a set of dumbbells so proper rowing can begin from Week 3+.

---

#### Low-Impact Cardio HIIT — Week 1

Format: HIIT intervals using low-impact, joint-friendly exercises.

**Interval Progression across sessions:**
- Session 1: 20 sec work / 40 sec rest
- Session 2: 25 sec work / 35 sec rest
- Session 3: 30 sec work / 30 sec rest
- **Cap at 30:30** — do not exceed until at least 3-4 weeks in

**Example exercises (low-impact, Week 1):**
- Marching jabs
- Step touches
- March in place

---

### WEEK 2+: Program Paths

#### Path A — No Equipment / Home (Whole Body Strength 1)

Same movement pattern framework as Basic Prep 1, with progressions:

| Pattern | Week 2 Exercise |
|---|---|
| Core | Dead bugs, bird dogs |
| Squat | Regular squat |
| Hinge | Deadlift (with DB) / Single-leg deadlift (no equipment) |
| Push | Push-up progression (advance week on week) |
| Pull | Band row / DB row / IYTWs (no equipment) |
| Single-leg | Step-ups → Reverse lunges → Forward lunges → Bulgarian split squats → Lateral lunges |
| Press (if DB available) | Overhead / shoulder press |

#### Path B — Gym Access (Upper/Lower/Cardio Split)

**Weekly Split:**
- Upper Body A | Lower Body A | Cardio | Upper Body B | Lower Body B
- Scale to available days

**Golden Rule: No workout repeats within the same week**
- Upper Body A ≠ Upper Body B
- Lower Body A ≠ Lower Body B
- Workouts CAN repeat week on week, but NEVER within the same week
- Applies to all splits regardless of format

---

### CARDIO HIIT PROGRESSION (Weeks 2+)

**Work/Rest:** Stays at 30:30 cap through first 3-4 weeks.
**Key progression lever:** Gradually introduce impact/plyometric exercises — add ONE new impact exercise per session. Rest of session stays low-impact.

**Impact Exercise Progression (introduce in this order):**
1. Straight shuffles
2. Side shuffles
3. Jumping jacks
4. Spiderman lunges (less explosive burpee alternative)
5. Burpees (most explosive — introduce last)

**Rule:** Only ONE impact exercise per session at beginner stage.

**After Week 3-4:**
- Work/rest ratio cap can be revisited (beyond 30:30)
- More impact exercises layered in gradually

---

### SESSION STRUCTURE (All Session Types)

Every session follows this structure:
1. **Warm-up** — 2-3 exercise mini circuit, 15-20 sec rest between exercises
2. **Main session** — 5-6 exercises (within 1 hour total)
3. **Cool-down** — 2-3 static stretches, 20-60 sec each, no rest between

---

### WARM-UP PHILOSOPHY

**Do not waste warm-up on generic cardio.** Use it to train undertrained muscles and prepare specifically for that session's demands.

#### Upper Body / Push Day Warm-Up
Target: shoulder stability, rotator cuff, anti-rotation core
- Bias towards shoulder stability exercises
- External/internal rotations, bar plank, shoulder taps, Turkish get-ups, Pallof press, wood chops, dead bugs, bird dogs, planks
- Expand pool with any exercise challenging shoulder stability or resisting rotation

#### Pull Day Warm-Up
Target: lat activation, mid-back activation, core stability
- Single-arm lat pull-down, single-arm cable pull-over, IYTWs, face pulls
- Core work — many pull movements require core stability
- Expand pool with any mid-back activation or lat engagement drill

#### Lower Body Warm-Up
Target: glute activation, gluteus medius, adductors, core stability

| Category | Exercises |
|---|---|
| Glute Activation | Glute bridges, kickbacks, banded glute sidewalks |
| Gluteus Medius | Clamshells, banded hip abductions |
| Adductors | Groin squeezes, banded hip adductions |
| Core Stability | Planks, side planks (especially before squats & deadlifts) |
| Balance & Stability | Alternating single-leg deadlift |
| Dynamic Mobility (3-4 months+) | Squat to stand, walking lunges, side lunges |

Vary exercises session to session. Include core work when main session involves spine-loading movements.

---

### COOL-DOWN PHILOSOPHY

Static stretching only. Select stretches targeting muscles most worked that session.

- **Duration per stretch:** 20-60 seconds (below 20 = ineffective; above 60 = diminishing returns)
- **Rest between stretches:** None — flow straight through
- **Volume:** 2-3 stretches

**Upper Body / Push Day Cool-Down Pool:**
Pec stretch, child's pose, lat stretch, cross-body shoulder stretch, overhead tricep stretch, behind-the-back bicep stretch

**Lower Body Cool-Down Pool:**
Hip flexor stretch, hamstring stretch, pigeon pose, quad stretch, seated groin stretch, calf stretch

---

### MAIN SESSION — MOVEMENT PATTERNS

#### Upper Body Day — 4 Required Patterns:
1. Horizontal Push (e.g. bench press, push-up)
2. Horizontal Pull (e.g. bent over row, seated row)
3. Vertical Push (e.g. overhead press, shoulder press)
4. Vertical Pull (e.g. lat pull-down, pull-up)
5. **Isolation work** after all 4 patterns covered
- Push/pull alternating rule applies on upper body days

#### Push Day — 2 Required Patterns:
1. Horizontal Push (multiple exercises)
2. Vertical Push (multiple exercises)
3. **Isolation work:** triceps, lateral raises, front raises, chest flys
- No push/pull alternating rule — entire session is push focused
- More scope for isolation variety since entire day is dedicated

#### Pull Day — 2 Required Patterns:
1. Horizontal Pull (multiple exercises)
2. Vertical Pull (multiple exercises)
3. **Isolation work:** biceps, face pulls, rear delt flys, mid-back
- No push/pull alternating rule — entire session is pull focused
- Pull days are relatively lower intensity — good candidate for HIIT finisher if needed

#### Lower Body Day — 3 Required Patterns:
1. Squat pattern
2. Hinge pattern
3. Lunge / Single-leg pattern — rotate between:
   - **Quad/Glute dominant:** Lunges, step-ups, single-leg squat, Bulgarian split squat
   - **Hamstring/Glute dominant:** Single-leg RDL, single-leg leg curl
4. **Isolation work:** leg extensions, leg curls, hip abductions, groin squeezes
- Single-leg work is non-negotiable — corrects left-right imbalances bilateral movements can mask

---

### EXERCISE SEQUENCING HIERARCHY

Applies to all session types:

**Layer 1 — By Movement Type:**
1. Power/plyometric movements
2. Tier 1 barbell compounds (barbell squat, barbell deadlift, barbell bent over row — most technically demanding, multi-joint)
3. Other barbell movements + dumbbell compounds
4. Machine compound movements
5. Isolation movements

**Layer 2 — Within Isolation, by Equipment:**
1. Dumbbell isolation
2. Machine isolation

**Layer 3 — Within Isolation, by Muscle Size:**
- Larger muscles before smaller muscles

| Body | Larger First | Smaller Later |
|---|---|---|
| Upper | Chest, back, shoulders | Biceps, triceps |
| Lower | Quads, hamstrings, glutes | Calves, adductors, abductors |

**Full sequence:** Power → Tier 1 Barbell Compounds → Other Barbell/Dumbbell Compounds → Machine Compounds → Dumbbell Isolation (large→small) → Machine Isolation (large→small)

**Flexibility note:** If a machine movement is more complex or demanding than a dumbbell variation in context, it can come first. Complexity and demand is the true north — the hierarchy is a strong guide, not a rigid cage. Barbell Tier 1 compounds always come first — that part is firm.

---

### PUSH/PULL ALTERNATING RULE (Upper Body Days Only)

- Always alternate push and pull exercises on upper body days
- Push = chest, shoulders, triceps | Pull = lats, mid back, biceps
- Does NOT apply on dedicated push or pull days
- Exception: Compound sets (same muscle group paired) allowed when targeting endurance

---

### SETS & REPS

**Volume Progression:**

| Stage | Sets |
|---|---|
| Beginner Week 1 | 2 sets across all exercises |
| Beginner Week 2-3 | Gradually introducing 3 sets on some exercises |
| Beginner Week 3-4 | 3 sets on majority of exercises |
| Intermediate baseline | 3 sets on majority of exercises |
| Intermediate advanced | 4, 5, or 6 sets on select priority exercises |

- 2 sets acceptable if time is a constraint at any level
- Higher set work (4-6 sets) requires reducing number of exercises to stay within 1 hour
- **Session length: 1 hour max, 1hr 10min absolute ceiling**

**Rep Range Philosophy — "Maturity of Training":**
- **60% of training: Hypertrophy range (8-12 reps)**
- **40% of training: Variety** — strength or endurance range as client progresses

**Rep Range Rules & Guardrails:**

| Client/Exercise Type | Rep Range |
|---|---|
| Absolute beginner (first 2 months) | 5-25 reps (primarily 8-12) |
| Isolation exercises | Never below 5 reps |
| Posture/mid-back exercises (face pulls, T raises) | 10+ reps always |
| Intermediate+ compound lifts | Can dip into strength range (<5 reps) |
| Maximum rep ceiling | 25 reps |

**Set Methodologies (introduce as client progresses):**

| Method | Pattern | Effect |
|---|---|---|
| Straight sets | 3x10, 3x8 | Baseline consistency |
| Descending sets | 10, 8, 6, 4, 2 | Increasing intensity |
| Ascending sets | 2, 4, 6, 8, 10 | Building into volume |
| Pyramid sets | 4, 6, 8, 6, 4 | Peak and taper |
| 5x5 | 5 sets of 5 reps | Strength focus |

**Supersets vs Compound Sets:**

| Type | Definition | When to Introduce |
|---|---|---|
| Superset | Opposing muscle groups (push + pull) | After 6+ weeks |
| Compound set | Same muscle group (push + push) | When targeting endurance |

---

### REST PERIODS

| Rep Range | Intensity | Rest Period |
|---|---|---|
| 12-25 reps | Endurance | 45 sec – 1 min |
| 6-12 reps | Hypertrophy | 90 sec – 2 min |
| <6 reps | Strength | 2-3 min |
| Very advanced/heavy | Elite only | 4-5 min (rare) |

---

### PROGRAM DURATION & PROGRESSION CYCLE

- **Weeks 1-3:** Same program repeated — consistency builds measurable progress
- **Week 3-4:** Change things up via different exercise selection, rep ranges, or set methodology
- **Key Principle:** Balance variety with consistency

---

## INTERMEDIATE METHODOLOGY

### Transition Threshold
- **2 months of consistent foundational training**
- Primarily time-based — consistent practice almost always produces good movement quality
- If poor form persists beyond 2 months, flag and monitor closely

### What Changes at Intermediate

**1. Strength Range Unlocked:**
- The 5-rep floor is removed
- Can now program sets below 5 reps with heavier loads — introduced slowly and gradually

**2. Volume Increases:**
- Intermediate baseline: 3 sets on majority of exercises
- Can go to 4, 5, or 6 sets on select priority exercises
- Always adjust total exercises to stay within 1 hour

**3. Power & Plyometric Work Introduced (on strength training days):**

| Category | Exercises |
|---|---|
| Lower body plyometrics | Squat jumps, box jumps |
| Upper body plyometrics | Plyo push-ups |
| Advanced push variations | Spiderman push-ups, diamond push-ups |

**Gender-Aware Programming:**
- Males: Introduce advanced push variations more aggressively
- Females: Progress based on current strength level — never rush
- Plyometrics: Applicable to almost everyone at intermediate regardless of gender

**4. Exercise Selection:**
- Same foundational pool as beginner
- Heavier loads, more technical variations, more variety

---

### INTERMEDIATE SPLITS

#### Option 1: Push/Pull/Legs + HIIT (6-day rolling split — Preferred for fat loss)
Cycle rolls continuously — does NOT reset on Monday:
**Cycle: Push → Pull → Legs → HIIT → repeat**

| Week 1 | Week 2 |
|---|---|
| Mon: Push | Mon: Legs |
| Tue: Pull | Tue: HIIT |
| Wed: Legs | Wed: Push |
| Thu: HIIT | Thu: Pull |
| Fri: Push | Fri: Legs |
| Sat: Pull | Sat: HIIT |
| Sun: Rest | Sun: Rest |

#### Option 2: Everything in One Week (fixed weekly reset)
Mon: Push | Tue: Pull | Wed: Legs | Thu: Cardio/HIIT | Fri: Upper Body | Sat: Lower Body | Sun: Rest

#### Option 3: Client Refuses Dedicated Cardio Day
Add HIIT finisher onto Pull days — lowest intensity day, best candidate to absorb cardio work.

#### Option 4: Whole Body Splits (3-4 days available)
- 4 days: Upper / Lower / Cardio / Whole Body
- 3 days: Whole Body A / Cardio / Whole Body B
- 3 days (strength focus): Upper / Lower / Whole Body

---

### WHOLE BODY PROGRAMMING

**Core Principle:** Cover all movement patterns every session, but alternate which patterns are trained heavy vs light.

**Whole Body A:**
| Pattern | Emphasis |
|---|---|
| Squat | Heavy (e.g. barbell squat) |
| Hinge | Light (e.g. dumbbell RDL) |
| Push | Heavy (e.g. barbell bench press) |
| Pull | Light (e.g. dumbbell row) |
| Single-leg | Included |
| 1-2 Isolation exercises | Based on client need |

**Whole Body B:**
| Pattern | Emphasis |
|---|---|
| Squat | Light (e.g. goblet squat, leg press) |
| Hinge | Heavy (e.g. barbell deadlift) |
| Push | Light (e.g. dumbbell shoulder press) |
| Pull | Heavy (e.g. barbell bent over row) |
| Single-leg | Included |
| 1-2 Isolation exercises | Based on client need |

**Whole Body C (optional 3rd day):**
- More flexible — can focus on isolation movements
- Still covers major upper and lower body muscles
- Doesn't need to rigidly follow all movement patterns
- Good for higher rep pump-style session or weak point training

**Heavy vs Light — Two Dimensions:**
1. **Load:** Heavy = higher load/lower reps | Light = lower load/higher reps
2. **Equipment:** If one pattern uses barbell → opposing pattern uses dumbbell/machine
   - Never two Tier 1 barbell compounds in the same whole body session
   - Example: Barbell squat + dumbbell RDL ✅ | Barbell squat + barbell deadlift ❌

---

### INTERMEDIATE CARDIO/HIIT

**Expanded Exercise Pool:**
- All previous bodyweight exercises plus weighted/technical movements
- Examples: thrusters, kettlebell swings, dumbbell snatches, burpees
- Always ensure balanced muscle group coverage — consider what's already been trained in strength sessions
- The examples above are anchors — any exercise fitting the intensity and format requirements works

**HIIT Formats:**

| Format | Description |
|---|---|
| Standard Intervals | Any work/rest split (30:30, 40:20, 1:1, 90sec:30sec) |
| AMRAP | As Many Rounds/Reps As Possible in set time |
| EMOM | Every Minute On the Minute |
| Descending Ladder | 10, 9, 8... down to 1 |
| Ascending Ladder | 1, 2, 3... up to 10 |
| Pyramid | Ascending then descending |
| Circuit with Rest | 3 exercises, rest between each, extended break after round |
| Circuit without Rest | 3 exercises back to back, extended 1-2 min break after round |
| Multi-exercise Ladder | 2-3 exercises combined in descending/ascending ladder |

**Ab Work on Cardio/HIIT Days:**
- Difficult to fit into push/pull/legs or upper/lower splits
- Cardio/HIIT day is the natural home for ab training

**Isolation Catch-Up on Cardio/HIIT Days:**
- Add isolation work that didn't fit into strength days (biceps, glutes, calves, lagging muscles)
- Structure: HIIT intervals first → isolation finisher after

**HIIT Pairing Rule (applies to ALL levels):**
- NEVER pair two exercises back to back that share the same primary muscle group or stability demand
- Cardiovascular system must always be the limiting factor, not localized muscle fatigue
- ❌ Mountain climbers + shoulder taps (both demand plank/core stability)
- ❌ Thrusters + burpees (both quad and shoulder dominant)
- ✅ Burpees + lateral shuffles | ✅ Kettlebell swings + jumping jacks

---

### CARRY PATTERN
- Farmer's walks and any loaded carry variation
- Optional — add when time allows, not mandatory every week
- Can be added to any day (push, pull, legs, upper, lower)
- **Rule: Never add on every day** — use sparingly and strategically
- Natural fit: pull days (grip and back demand overlap)
- Benefits: grip strength, core stability under load, full body tension, functional strength

---

## ATHLETE METHODOLOGY
*(To be added — less common client profile, will be refined separately)*

---

## REHAB CONSIDERATIONS
*(To be added)*

---

## Output Format

When building a workout program, always output:
1. **Client Summary** — brief restatement of their goal, level, equipment, days, preferences
2. **Weekly Structure** — which type of session on which days
3. **Session Breakdown** — for each session type, list exercises with sets/reps/intervals
4. **Progression Notes** — what to watch for, when to advance
5. **Coaching Cues** — key form notes or YouTube references where helpful

---

## REHAB CONSIDERATIONS

### Scope of Practice — Critical First Step

**Always assess before programming:**

| Condition | Action |
|---|---|
| ACL tear, disc herniation, significant structural injury | Refer to physio — do not program independently |
| General knee pain, back pain, minor aches | Can work through with appropriate modifications |
| Any condition requiring medical diagnosis | Refer out — when in doubt, refer out |

**Golden Rule:** Never program through pain. Discomfort from effort is different from pain from injury. If an exercise causes pain — stop, modify, or substitute.

---

### KNEE PAIN

**Core Principle:** Gradually reintroduce squats — never rule them out permanently. Find the pain-free range and work within it.

**Squat Progression Ladder:**

| Stage | Exercise | Condition to Progress |
|---|---|---|
| 1 | Isometric wall sit (elevated, above 90°) | No pain at current height |
| 2 | Lower wall sit height gradually | No pain at each new depth |
| 3 | Bodyweight box squat | No pain |
| 4 | Weighted box squat (add load gradually) | No pain with load |
| 5 | Regular bodyweight squat | No pain |
| 6 | Regular weighted squat | No pain |

**Rules:**
- Never skip a stage
- Never progress if there is pain at current stage
- If pain appears → go back to previous stage
- Timeline is client-dependent — could be weeks or months

**Avoid Until Pain Resolves:**
- ❌ Full depth squats
- ❌ All lunge variations
- ❌ High step-ups

**Safe Alternatives:**
- Low step-ups (smaller height)
- Hip-dominant movements (shift load away from knee):
  - Romanian deadlifts
  - Hip thrusters
  - Glute bridges
  - Clamshells
  - Hip abductions
- Isolation work (gym): leg extensions, leg curls (controlled, pain-free range)

**Supplementary Rehab Work (10-15 min — warm-up, cool-down, or separate session):**
- Foam rolling IT band
- Glute strengthening (glute bridges, hip thrusters, clamshells)
- Hip abduction work
- Rationale: Strong glutes reduce load and stress on the knee joint

---

### LOWER BACK PAIN

**Core Principle:** Avoid or replace any exercise where the spine is unsupported or heavily loaded. Prefer supported, machine-based, or horizontal alternatives. Pain is always the guide.

**Important Note:** Avoid movement patterns that cause pain. If a client has no pain with a particular movement, it can be included — but always err on the side of caution with the modifications below.

**Squat Pattern — Modified Progression:**

| Stage | Exercise | Notes |
|---|---|---|
| 1 | Horizontal leg press | Fully supported spine, minimal spinal load |
| 2 | Angled leg press | Slight spinal load — progress carefully |
| 3 | Smith machine squats | Guided movement |
| 4 | Dumbbell / goblet squats | Free weight but manageable load |
| 5 | Regular parallel squats | Only when completely pain-free |

**Hinge Pattern — Modified Progression:**
- Start with hip hinge using a dowel/stick (reinforces spine-neutral pattern before any load)
- Avoid deadlifts initially
- If introducing deadlifts: start very light (15 reps, minimal load)
- Progress to Romanian deadlifts slowly and gradually
- Non-negotiable: hip hinge with dowel always comes before any loaded hinge

**Pull Pattern — Substitutions:**

| Avoid | Replace With |
|---|---|
| Bent over rows | Chest supported rows, incline bench rows |
| Barbell rows | Single-arm supported dumbbell rows |

**Push Pattern — Substitutions:**

| Avoid | Replace With |
|---|---|
| Standing shoulder press | Seated shoulder press (leaning against bench) |

**General Rules:**
- ❌ Any unsupported spine movement — avoid or modify
- ❌ Heavy spinal loading — avoid until pain resolves
- ✅ Machine-based and supported alternatives always preferred
- ✅ Horizontal before angled before vertical loading progression

**Rehab & Supplementary Work:**

**Common Mistake:** Just stretching the back — not the most beneficial approach. The back is often a symptom, not the cause.

**What Actually Helps:**

1. **Hip Mobility Work:**
   - Piriformis release and stretch (commonly gets tight)
   - Hip flexor stretches
   - Adductor stretches
   - Better hip mobility = less compensatory load on lower back

2. **Core Strengthening (pain-free only):**
   - Anti-rotation movements with band (Pallof press)
   - Planks, side planks
   - Dead bugs (gentle, controlled)
   - ❌ Avoid excessive crunches

3. **Hip Hinge Retraining:**
   - Hip hinge with dowel/stick before any loaded hinge
   - Reinforces spine-neutral pattern

**Delivery:** Add to warm-up, cool-down, or dedicated 10-15 min separate session

**Sample Lower Body Day — Back Pain Client:**

*Warm-Up (activation, not stretching):*
1. Hip hinge with dowel — 10 reps
2. Glute bridges — 10-12 reps
3. Dead bugs — 8-10 reps

*Main Session:*
1. Horizontal leg press — 3x10-12 (supported squat pattern)
2. Weighted glute bridge — 3x12-15 (supported hinge)
3. Low step-ups — 3x10 each side (single-leg, controlled)
4. Seated leg curl — 3x12-15 (machine, fully supported)
5. Clamshells — 3x15 (hip abduction)

*Cool-Down (static stretching):*
1. Piriformis stretch — 40 sec each side
2. Hip flexor stretch — 40 sec each side
3. Adductor stretch — 40 sec each side

---

### SHOULDER PAIN

**Prevention First (for ALL clients):**
- Maintain push/pull balance throughout programming — imbalance is the most common root cause
- Regularly include rotator cuff work in warm-ups
- Work on scapular muscles consistently

**When Shoulder Pain Presents:**

**Step 1 — Identify the painful movement:**
- Overhead pressing?
- Overhead pulling?
- Horizontal pressing (parallel)?
- Dumbbell pressing specifically?
- Only avoid what actually causes pain — don't eliminate everything

**Step 2 — Increase Stability & Rehab Work:**

| Category | Exercises |
|---|---|
| Rotator Cuff Activation | External rotations, internal rotations |
| Isometric Stability | External rotation holds |
| Release Work | Pec release, lat release, shoulder release |
| Scapular Work | IYTWs, scap retractions, face pulls |

**Step 3 — Movement Pattern Modifications:**

| Common Pain Trigger | Modification |
|---|---|
| Overhead pressing | Replace with landmine press, incline press, or avoid temporarily |
| Overhead pulling | Replace with horizontal pull variations (rows) |
| Parallel horizontal press | Try incline or decline — find pain-free range |
| Dumbbell pressing | Try barbell or machine variation instead (or vice versa) |

**Key Rules:**
- ❌ Never press through shoulder pain
- ✅ More pull than push temporarily — restores balance, reduces impingement
- ✅ Stability and rotator cuff work becomes a priority, not just a warm-up afterthought
- ✅ Release tight pecs and lats — tightness pulls shoulder into poor position
- ✅ Find the pain-free range and work within it

**Overarching Principle:** Shoulder pain is almost always a balance and stability issue — too much pushing, not enough pulling, neglected rotator cuff work. Address the root cause, not just the symptom.

---

### GENERAL REHAB PRINCIPLES (Applies to All Conditions)

1. **Never program through pain** — pain is always the guide
2. **Refer out for serious injuries** — ACL, disc herniation, structural damage
3. **Find the pain-free range** — work within it, expand it gradually
4. **Address root causes** — weak glutes for knee pain, tight hips for back pain, push/pull imbalance for shoulder pain
5. **Warm-up = activation, not stretching** — even for rehab clients
6. **Cool-down = static stretching** — target muscles around the injury
7. **Supplementary rehab work** — can be warm-up, cool-down, or dedicated 10-15 min session
8. **Progress is always gradual** — never rush loading or movement complexity
9. **Supported before unsupported** — machine before dumbbell before barbell for injured clients
10. **Horizontal before vertical loading** — reduce gravitational spinal load progressively

---

## ATHLETE METHODOLOGY

### Athlete Definition

A client is considered an athlete when they meet these criteria:

| Criteria | Threshold |
|---|---|
| Training history | 3-4+ months past intermediate (5-6+ months total consistent training) |
| Goals | More intense — performance, strength, power, sport-specific |
| Sport participation | At least recreational — plays a sport regularly |

**Two types:**
1. **Recreational athletes** — the majority; play sport regularly but not at high competitive level
2. **Competitive athletes** — less common; sport performance is primary goal

---

### Athlete Programming Philosophy

**Primary Goal:** Improve sport performance — not purely hypertrophy or aesthetics

**Preferred Splits:** Upper / Lower / Cardio or Whole Body + Cardio
- PPL is hypertrophy-focused — not ideal for most athletes
- Upper/lower and whole body splits train movement patterns more holistically
- **Exception:** Powerlifters or strength-sport athletes where PPL makes sense

---

### Three Phases of Athlete Programming

Even athletes go through the same foundational progressions before sport-specific work is layered on. Training age in the gym matters more than sporting experience.

| Phase | Focus | Programming Style |
|---|---|---|
| **Phase 1 — Foundation** | Endurance-based strength, movement quality | Beginner methodology — same framework regardless of sport |
| **Phase 2 — Base Building** | Hypertrophy, strength foundation | Intermediate methodology — build muscle and strength base |
| **Phase 3 — Sport-Specific** | Power, stability, sport-specific drills | Athlete-specific additions layered on top |

**Key Rule:** An absolute beginner who plays a sport still starts at Phase 1 — never skip the foundation phase regardless of sporting background.

---

### Phase 3 — Sport-Specific Additions

**Strength Side (largely universal across all sports):**
1. Build base level of strength (Phase 1 & 2)
2. Build power — more plyometrics, explosive movements
3. Add sport-specific stability work:
   - More unilateral movements
   - Single-leg stability work
   - Single-arm work
   - Balance and coordination challenges

**Conditioning Side (changes based on sport):**
The key athletic conditioning quality most sports share is **Repeat Sprint Ability (RSA)** — the ability to repeatedly produce high-intensity efforts with short recovery.

**Conditioning by Sport Energy System:**

| Sport Type | Energy System | Conditioning Approach |
|---|---|---|
| Field/court sports (football, basketball, hockey) | Alactic + Lactic | Repeat sprint intervals, short work periods, incomplete rest |
| Racket sports (tennis, badminton, squash) | Alactic + Aerobic | Mixed intervals, agility-based conditioning |
| Combat sports (MMA, boxing) | Alactic + Lactic | Round-based HIIT matching fight duration |
| Endurance sports (running, cycling, swimming) | Aerobic dominant | Longer duration, steady state + tempo work |
| Strength sports (powerlifting, weightlifting) | Alactic | Minimal conditioning — focus stays on strength |

---

### CRICKET-SPECIFIC PROGRAMMING

Cricket demands both aerobic endurance (long match days) and explosive repeat sprint ability (running between wickets, fielding sprints). Most clients will be recreational cricketers — role-specific periodization is not required at this level.

#### Beginner Cricketer Rule
- ❌ No shuttle running or running drills at absolute beginner stage
- ✅ Focus on strength training with lower impact conditioning first
- Gradually introduce running and agility drills as base fitness builds
- Same beginner methodology applies — sport doesn't override the foundation phase

#### Cricket Strength Day — Exercise Pool

**Standard framework applies (upper/lower/whole body splits)**

Cricket-specific additions:

| Exercise | Category | Notes |
|---|---|---|
| Cook Hip Lift | Hamstring/glute activation | Teaches muscles to fire correctly during running — good warm-up or supplementary exercise |
| Swiss ball / stability ball hamstring curls | Hamstring | Start here before progressing to Nordic curls |
| Nordic hamstring curls | Hamstring | Late stage only — too intense for early programming |
| Medicine ball slams | Power | Fine for intermediate+ — avoid overhead throwing variations for beginners and intermediates |
| Wood chops | Rotational power | Transfers directly to batting and throwing |
| Lateral bounds | Explosive lateral movement | Late stage only — introduce only after solid strength base |
| Rotator cuff work | Shoulder stability | Critical given bowling and throwing demands — external/internal rotations, IYTWs |
| Single-leg work | Stability | Extra emphasis for cricketers — running and fielding demands |

#### Cricket Conditioning — Three Tracks

**Track 1 — Aerobic Base (Longer Distance, Lower Intensity):**
- Build gradually:
  - Start: 1 km run
  - Build to: 2 km → 3 km → 5-6 km
- Pace: Comfortable, not all out
- Purpose: Sustain energy across long innings and full match days
- Also use: Fartlek runs — unstructured speed play mixing sprints with jogging

**Track 2 — Sprint Training (Two Types):**

| Type | Format | Purpose |
|---|---|---|
| All-out sprints | Maximal effort, full recovery between reps | Raw speed development |
| Repeat sprint ability | Shuttle runs 10-20m, 1:1 or 1:2 work:rest, 5-6 sets at 80-100% | Simulates repeated fielding sprints and running between wickets |
| Stop-and-go drills | Sprint 30m at 90%, jog 20m, walk 10m — repeat | Mimics changing pace of cricket — sprinting, jogging, stopping |

> **Important:** Shuttle runs and sprint drills only after client develops solid aerobic base fitness first

**Track 3 — HIIT Strength & Conditioning Hybrid:**
- Combination of strength and conditioning elements
- High intensity intervals: 1-4 minute intervals at ~75% max speed
- Change of direction drills: lateral shuffle, crossover steps
- Metabolic strength circuits (e.g. stair lunges + farmer's walks)

#### Cricket Agility Drills (introduce after base fitness established):
- Tee drills
- X-cone drills
- Ladder drills
- Change of direction wall drills (lateral shuffle, crossover step)

#### Single Conditioning Session — Can Train All Aspects:

Suggested order within one conditioning day:
1. **Agility drills** (requires freshness and coordination — do first)
2. **All-out sprints** (maximal effort — while still fresh)
3. **Repeat sprint ability** (shuttles — slightly fatigued, mimics match conditions)
4. **Endurance closer** (longer run, lower intensity to close out)

#### Equipment & Environment Rule:
- Always assess what environment and equipment the client has access to before programming outdoor conditioning drills
- ❌ Don't program hill sprints, stair sprints, or agility setups if client doesn't have access
- Find alternatives that work within their actual environment

#### Avoid Doubling Up on Conditioning:
- If client is already doing conditioning in their sport training (practice sessions, matches) → don't add more on top
- Assess what they're already doing and fill the gaps only
- Account for sport load outside the gym to avoid overtraining

---

### GENERAL ATHLETE PRINCIPLES

1. **Foundation before sport-specificity** — always build strength base first regardless of sport
2. **Strength programming is largely universal** — conditioning is where sport-specificity comes in
3. **Upper/lower or whole body splits preferred** over PPL for most athletes
4. **Repeat sprint ability** is the key conditioning quality for most team sports
5. **Account for sport load** — training in the gym should complement, not duplicate, what they do in their sport
6. **Equipment and environment** — always check what's available before programming outdoor or equipment-specific drills
7. **Gradual introduction** of plyometrics, agility, and high-intensity sprint work — build the base first
8. **Rotator cuff and shoulder stability** — critical for throwing/overhead sports, always include in warm-ups

---

## PROGRESSIVE OVERLOAD GUIDELINES

### Core Principle
Rep range stays consistent for 3-4 weeks. Within that period, progressive overload is achieved by increasing weight when the client can complete all prescribed reps across all sets.

---

### Weighted Exercise Progression System

**Phase 1 — Trigger to Increase Weight:**
- Client completes ALL prescribed reps across ALL sets with current weight
- Example: 3x12 at 10kg — all 36 reps completed ✅ → increase weight next session

**Phase 2 — After Weight Increase, Two Scenarios:**

**Scenario A — Client gets ≥ half the prescribed reps at new weight:**
- Continue with new weight for ALL sets
- Don't worry about hitting full rep target immediately
- Example: Prescribed 12 reps → gets 7, 7, 6 at new weight — acceptable
- Goal: Gradually work back up to full prescribed reps at new weight
- Once full reps achieved at new weight → increase weight again (back to Phase 1)

**Scenario B — Client gets < half the prescribed reps at new weight:**
- Set 1: New (heavier) weight — however many reps they can manage
- Sets 2 & 3: Drop back to old weight — complete remaining sets normally
- Keep attempting Set 1 with new weight each session until ≥ half reps achieved
- Once halfway threshold crossed → move to Scenario A (all sets at new weight)
- Then gradually work back to full prescribed reps

**Progression Ladder:**
\`\`\`
Complete all reps at current weight
         ↓
Increase weight
         ↓
    ┌────┴────┐
≥ Half reps   < Half reps
    ↓              ↓
All sets at    Set 1 at new weight
new weight     Sets 2&3 at old weight
    ↓              ↓
Work back to   Keep trying Set 1 until
full rep target  ≥ half reps achieved
    ↓              ↓
Increase weight again → Move to left path
\`\`\`

---

### Weight Increment Rule
- Use the **smallest available increment** in the gym
- Standard in most gyms: **2.5kg increments** for both upper and lower body
- If smaller increments available (1kg, 1.25kg) → use those for more gradual progression
- If only larger increments available → work with what's there
- **Rule:** Always choose the most gradual progression possible with equipment available

---

### Bodyweight Exercise Progression

Bodyweight exercises have a natural ceiling — there is no clean structured overload system like weighted exercises. Be creative and honest about limitations.

**Push-Up Progression Example:**

| Stage | Approach |
|---|---|
| Can't do full push-ups yet | Follow push-up progression ladder (wall → knee → incline → full) |
| Can do 12-15 push-ups (gym) | Retire as main exercise → use as warm-up, introduce weighted pressing |
| Can do 12-15 push-ups (home) | Progress to advanced variations |
| Advanced variations | Diamond, Spiderman, clap, plyo push-ups |
| Can do 20-30 reps easily | Add as compound set with bench press |
| Ceiling reached | Accept limitation — bodyweight has a natural ceiling |

**General Bodyweight Progression Methods (in order):**
1. **Increase reps** — push towards 20, then 30 reps before changing exercise
2. **Advance the variation** — make movement harder (diamond, plyo, single-leg etc.)
3. **Change tempo** — slower eccentric, pause at bottom
4. **Add to supersets or compound sets** — pair with weighted exercise to increase demand
5. **Retire and replace** — once too easy at gym, move to weighted equivalent and use bodyweight as warm-up only

---

### Sets Progression
- Start at 2 sets (absolute beginner)
- Introduce 3 sets on some exercises by Week 2-3
- Majority at 3 sets by Week 3-4
- Intermediate: 3 sets baseline, up to 4-6 sets on select exercises
- Always adjust total number of exercises if adding sets to stay within 1 hour

### Rep Range Progression
- Rep range stays consistent for 3-4 weeks
- After 3-4 weeks → change rep range, set methodology, or exercise selection
- This change can come in the form of ascending sets, descending sets, pyramid sets, or new exercises

---

## SAMPLE WORKOUTS

> These are reference examples showing style, structure, and format. Always adapt to the specific client's goal, level, equipment, and limitations. Never copy-paste — use these as a guide for how a well-programmed session should look and feel.

---

### SAMPLE 1: Absolute Beginner Female — Weight Loss — No Equipment — Resistance Bands — 5 Days/Week

**Client Profile:**
- Goal: Weight loss
- Level: Absolute beginner
- Equipment: Resistance bands only, no gym
- Days: 5 days/week

**Week 1 Structure:**
- Day 1: Basic Prep 1
- Day 2: Low-Impact Cardio HIIT
- Day 3: Basic Prep 1 (slight progression)
- Day 4: Low-Impact Cardio HIIT (slight progression)
- Day 5: Basic Prep 1 (slight progression)
- Day 6: Rest (or optional light walk)
- Day 7: Rest

> Note: If client can train 6 days, Day 6 becomes another Cardio HIIT session

---

#### DAY 1 — Basic Prep 1

**Warm-Up:** Integrated into session — foundational exercises serve as activation

**Main Session:**

| Exercise | Sets | Reps / Duration | Notes |
|---|---|---|---|
| T's and W's (prone) | 3 | 10 reps | Start with T's and W's before progressing to full IYTWs |
| Supine marches | 3 | 6 each side | Dead bugs too intense at this stage |
| Bird dogs | 3 | 6 each side | Slow and controlled |
| Wall sit | 3 | 20 sec | Adjust height to comfortable, pain-free range |
| Incline plank (hands on bench/elevated surface) | 3 | 20 sec | Elevated to make manageable |
| Wall push-ups | 3 | 10 reps | |
| Glute bridges | 3 | 10-12 reps | |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Piriformis stretch | 40 sec each side |
| Hip flexor stretch | 40 sec each side |

> **Sets note:** 3 sets acceptable for foundational bodyweight exercises. 2-set rule applies when weighted exercises are introduced.

---

#### DAY 2 — Low-Impact Cardio HIIT

**Warm-Up:**
- Marching in place — 1-2 minutes
- Jogging in place — 1-2 minutes

**Main Session — 4 Rounds:**

| Exercise | Work | Rest |
|---|---|---|
| Knee to elbow (standing, opposite knee to opposite elbow) | 20 sec | 40 sec |
| Elevated plank / floor plank (based on core strength from Day 1) | 20 sec | 40 sec |
| Jabs | 20 sec | 40 sec |
| Marching in place | 20 sec | 40 sec |
| **Rest between rounds** | | **1-2 minutes** |

Repeat for **4 rounds total**

**Plank Decision Rule:**
- If elevated plank felt comfortable on Day 1 → try floor plank
- If still challenging → continue elevated plank, increase duration instead
- Never force progression — comfort and form always first

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Downward dog | 40 sec |
| Child's pose | 40 sec |
| Cat-cow | 40 sec |

---

#### DAY 3 — Basic Prep 1 (Progression)

Same exercises as Day 1 — slight increase in reps and duration:

| Exercise | Sets | Reps / Duration | Progression from Day 1 |
|---|---|---|---|
| T's and W's (prone) | 3 | 10 reps | Same |
| Supine marches | 3 | 8 each side | ↑ from 6 |
| Bird dogs | 3 | 8 each side | ↑ from 6 |
| Wall sit | 3 | 25 sec | ↑ from 20 sec |
| Incline / floor plank | 3 | 25 sec | ↑ from 20 sec |
| Wall push-ups | 3 | 10-12 reps | Slight increase if comfortable |
| Glute bridges | 3 | 12 reps | Slight increase if comfortable |

**Cool-Down:** Same as Day 1

---

#### DAY 4 — Low-Impact Cardio HIIT (Progression)

Same exercises as Day 2 — interval progression:

**Main Session — 4 Rounds:**

| Exercise | Work | Rest |
|---|---|---|
| Knee to elbow | 25 sec | 35 sec |
| Elevated / floor plank | 25 sec | 35 sec |
| Jabs | 25 sec | 35 sec |
| Marching in place | 25 sec | 35 sec |
| **Rest between rounds** | | **1-2 minutes** |

**Cool-Down:** Same as Day 2

---

#### DAY 5 — Basic Prep 1 (Further Progression)

Continue gradual increases in reps and duration where appropriate. Assess client comfort and only progress if previous session felt manageable.

**Main Session:**

| Exercise | Sets | Reps / Duration | Notes |
|---|---|---|---|
| T's and W's (prone) | 3 | 10-12 reps | |
| Supine marches | 3 | 8-10 each side | |
| Bird dogs | 3 | 8-10 each side | |
| Wall sit | 3 | 25-30 sec | |
| Incline / floor plank | 3 | 25-30 sec | |
| Wall push-ups | 3 | 12 reps | |
| Glute bridges | 3 | 12-15 reps | |

**Cool-Down:** Same as Day 1

---

#### WEEK 1 PROGRESSION SUMMARY

| Session | Basic Prep Reps | Plank/Wall Sit Duration | HIIT Intervals |
|---|---|---|---|
| Day 1 | 6 each side | 20 sec | — |
| Day 2 | — | — | 20 sec work / 40 sec rest |
| Day 3 | 8 each side | 25 sec | — |
| Day 4 | — | — | 25 sec work / 35 sec rest |
| Day 5 | 8-10 each side | 25-30 sec | — |

**HIIT Interval Cap:** 30 sec work / 30 sec rest — do not exceed until at least Week 3-4


---

### SAMPLE 2: Beginner — Gym Access — 5 Days/Week

**Client Profile:**
- Goal: Weight loss / general fitness
- Level: Beginner
- Equipment: Full gym access
- Days: 5 days/week

**Weekly Structure:**
- Day 1: Upper Body A
- Day 2: Lower Body A
- Day 3: Cardio HIIT
- Day 4: Upper Body B
- Day 5: Lower Body B

---

#### DAY 1 — Upper Body A

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps |
|---|---|
| Cable / band external rotations | 10 each side |
| Dead bugs | 10 each side |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest |
|---|---|---|---|---|---|
| 1 | Dumbbell chest press | Horizontal push | 2 | 10 | 90 sec |
| 2 | Lat pull-down | Vertical pull | 2 | 10 | 90 sec |
| 3 | Dumbbell shoulder press | Vertical push | 2 | 10-12 | 90 sec |
| 4 | Seated row | Horizontal pull | 2 | 12-15 | 90 sec |
| 5 | Dumbbell reverse flys | Isolation — rear delts | 2 | 15 | 60 sec |
| 6 | Alternating dumbbell bicep curls | Isolation — small muscle | 2 | 10-12 | 60 sec |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Pec stretch | 30 sec each side |
| Child's pose (both directions) | 30 sec each side |

---

#### DAY 2 — Lower Body A

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps |
|---|---|
| Clamshells | 10-15 each side |
| Glute bridges | 10-15 reps |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Weighted box squats | Squat | 2 | 10 | 90 sec | Client sits to box and stands — builds confidence and control |
| 2 | Hip hinge with stick / Romanian deadlift | Hinge | 2 | 10 | 90 sec | Hip hinge with stick if not confident with RDL — progress when ready |
| 3 | Step-ups / supported lunges | Single-leg quad dominant | 2 | 10 each side | 90 sec | Step-ups preferred for absolute beginners |
| 4 | Machine seated leg curl | Isolation — hamstrings | 2 | 12-15 | 60 sec | |
| 5 | Machine seated leg extension | Isolation — quads | 2 | 12-15 | 60 sec | |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Piriformis stretch | 40 sec each side |
| Frog stretch | 40 sec |

---

#### DAY 3 — Cardio HIIT

**Warm-Up (choose one):**
- Walking on treadmill — 10 minutes
- Cycling — 10 minutes
- Elliptical — 10 minutes

**Main Session — 4 rounds:**

| Exercise | Work | Rest | Notes |
|---|---|---|---|
| Side shuffles | 25 sec | 35 sec | Low impact — lateral movement |
| Farmer's carry | 25 sec | 35 sec | Full body — grip, core, conditioning |
| Spiderman lunges | 25 sec | 35 sec | Mobility dominant — lower body secondary |
| Jumping jacks | 25 sec | 35 sec + **1-2 min after round** | One impact exercise — always last |

Repeat for **4 rounds total**

**Active Cool-Down (optional — only when time allows):**
- Slow walk — 10-15 minutes
- Allows heart rate to gradually come down, burns additional calories

**Static Cool-Down Stretches:**

| Stretch | Duration |
|---|---|
| Hamstring stretch | 40 sec each side |
| Cobra stretch | 40 sec |
| Hip flexor stretch | 40 sec each side |

---

#### DAY 4 — Upper Body B

**Warm-Up — 2 rounds, 10-15 sec rest between exercises:**

| Exercise | Reps |
|---|---|
| Thoracic rotations | 10 each side |
| Shoulder taps | 10 each side |
| Bird dogs | 10 each side |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Dumbbell incline chest press | Horizontal push | 2 | 10 | 90 sec | |
| 2 | Reverse grip lat pull-down / machine-assisted pull-up | Vertical pull | 2 | 10 | 90 sec | |
| 3 | Arnold press | Vertical push | 2 | 10-12 | 90 sec | |
| 4 | Single-arm dumbbell row | Horizontal pull | 2 | 12-15 | 90 sec | |
| 5 | Dumbbell lateral raises | Isolation — shoulders | 2 | 15 | 60 sec | |
| 6 | Face pulls *(if time allows)* | Isolation — rear delts | 2 | 15 | 60 sec | Minimum one upper body day must have rear delt work |
| 7 | Tricep pushdown / tricep extension | Isolation — small muscle | 2 | 10-12 | 60 sec | |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Pec stretch | 30 sec each side |
| Lat stretch | 30 sec each side |
| Tricep stretch | 30 sec each side |

---

#### DAY 5 — Lower Body B

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps | Notes |
|---|---|---|
| Banded glute sidewalks | 10-15 each side | |
| Donkey kickbacks | 10-15 each side | Better glute activation than single-leg glute bridges for beginners |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Sumo squat | Squat | 2 | 10 | 90 sec | Different variation from Lower Body A |
| 2 | Romanian deadlift / Hip thruster | Hinge | 2 | 10 | 90 sec | Progress from hip hinge; hip thruster is a hinge variation targeting similar muscles |
| 3 | Supported lateral lunge / side step-ups | Single-leg quad dominant | 2 | 10 each side | 90 sec | Different pattern from Lower Body A |
| 4 | Single-leg hamstring curl | Isolation — hamstrings (single leg) | 2 | 10-12 each side | 60 sec | Addresses single-leg hamstring dominant pattern |
| 5 | Machine seated abduction / adduction | Isolation — adductors/abductors | 2 | 12-15 | 60 sec | Different isolation from Lower Body A |
| 6 | Farmer's carry *(if time allows)* | Carry pattern | 2 | 20-30 meters | 60 sec | Optional |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Hip flexor stretch | 40 sec each side |
| Hamstring stretch | 40 sec each side |

---

#### KEY PROGRAMMING NOTES — BEGINNER GYM SPLIT

**Rear Delt Rule:**
- Minimum one upper body day must include dedicated rear delt work
- Ideal: both upper body days if session length allows
- Never completely ignore rear delts across the week

**Hip Thruster Classification:**
- Categorized as a hinge variation — targets similar muscle groups to RDL
- Progression path: Glute bridge → Hip thruster → Romanian deadlift → Deadlift

**Single-Leg Balance Across Week:**
- Not a strict alternating rule — balance quad-dominant and hamstring-dominant single-leg work across the week
- Lower Body A: Step-ups (quad dominant)
- Lower Body B: Lateral lunge (quad dominant) + single-leg hamstring curl (hamstring dominant)
- Assess weekly to ensure both categories are covered

**Active Cool-Down on Cardio Days:**
- Optional slow walk (10-15 min) before static stretching
- Use only when client has extra time available
- Helps heart rate gradually come down and burns additional calories

---

### SAMPLE 3: Intermediate Male — Muscle Gain — Gym Access — 6 Days/Week — Rolling PPL + HIIT Split

**Client Profile:**
- Goal: Muscle gain
- Level: Intermediate (2+ months consistent training)
- Equipment: Full gym access
- Days: 6 days/week
- Split: Rolling PPL + HIIT (Push → Pull → Legs → HIIT → repeat)

**Weekly Structure (Rolling — does not reset on Monday):**
- Day 1: Push
- Day 2: Pull
- Day 3: Legs
- Day 4: HIIT
- Day 5: Push
- Day 6: Pull
- Day 7: Rest
- Day 8: Legs
- Day 9: HIIT... (continues rolling)

> **HIIT Note:** For muscle gain clients, HIIT is only introduced after 2-3 months of consistent training, and only once per week maximum. Not programmed at all in early muscle gain phase.

---

#### PUSH DAY

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps | Notes |
|---|---|---|
| Turkish get-ups | 2 each side | Full body shoulder stability activation |
| Lock Big 3 activation | 25 reps each position | Prone shoulder activation sequence — T raises → reverse front raise palms down → reverse front raise palms up. Light or no weight. Share reference video with client |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest |
|---|---|---|---|---|---|
| 1 | Barbell bench press | Horizontal push — Tier 1 compound | 3-5 | 5 | 2 min |
| 2 | Incline dumbbell chest press | Horizontal push — dumbbell | 3 | 8-12 | 90 sec |
| 3 | Smith machine shoulder press | Vertical push — machine | 3 | 8-12 | 90 sec |
| 4 | Cable high to low chest fly | Horizontal push isolation | 3 | 12-15 | 60 sec |
| 5 | Lateral raises | Isolation — shoulders | 3 | 12-15 | 60 sec |
| 6 | Barbell skull crushers | Isolation — triceps | 3 | 12-15 | 60 sec |
| 7 | Tricep kickbacks | Isolation — triceps (small muscle) | 3 | 15-20 | 60 sec |

**Cool-Down:**

| Stretch | Duration | Notes |
|---|---|---|
| Dumbbell chest stretch | 40 sec | Hold bottom of fly position with light dumbbells, let gravity open chest, drop dumbbells gently when done |
| Pole-assisted lat stretch | 40 sec | Hold sturdy surface to side, push body outward to feel lat stretch |

---

#### PULL DAY

**Warm-Up — 2 rounds, 10 sec rest between exercises:**

| Exercise | Reps | Notes |
|---|---|---|
| Side plank with hip dips | 10 each side | Drop and raise hip from side plank position — core and lateral stability |
| Dumbbell T raises | 15 | Prone, arms out to T — upper back and rear delt activation |
| Single-arm lat pull-down | 10 each side | Lat activation before main session |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Pull-ups / Weighted pull-ups | Vertical pull — Tier 1 compound | 3 | 6-10 | 2 min | Bodyweight if still building; add weight when 6-10 reps feel easy |
| 2 | Dumbbell bent over row | Horizontal pull — dumbbell compound | 3 | 8-12 | 90 sec | |
| 3 | Close grip lat pull-down | Vertical pull — machine | 3 | 12-15 | 60 sec | |
| 4 | Wide grip seated row | Horizontal pull — machine | 3 | 12-15 | 60 sec | |
| 5 | Incline bicep curls | Isolation — biceps | 3 | 12-15 | 60 sec | |
| 6 | Preacher curls | Isolation — biceps (small muscle) | 3 | 15-20 | 60 sec | |
| 7 | Incline bench prone Y raises *(if time allows)* | Isolation — rear delts, lower traps | 3 | 20 | 60 sec | Face down on incline bench, arms in Y position |

**Cool-Down:**

| Stretch | Duration | Notes |
|---|---|---|
| Child's pose (both directions) | 40 sec each side | |
| Pole-assisted lat stretch | 40 sec | Hold sturdy surface, push body outward to feel lat stretch |

---

#### LEGS DAY

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps / Duration | Notes |
|---|---|---|
| Banded sidewalks | 15 each side | Glute med activation |
| Stability ball plank | 60 sec | Elbows on stability ball — adds instability, greater core challenge |
| Bodyweight lateral lunges | 5 each side | Dynamic mobility — prepares hips and adductors |

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Barbell squats | Squat — Tier 1 compound | 3-5 | 5 | 2.5 min | Heaviest, most technical — always first |
| 2 | Dumbbell Romanian deadlift | Hinge — dumbbell compound | 3 | 6-10 | 90 sec | |
| 3 | Bulgarian split squat | Single-leg quad dominant | 2 | 8-12 | 90 sec | 2 sets intentional — manages fatigue after heavy squats and RDLs. Each set is effectively double the demand of bilateral exercises |
| 4 | Machine single-leg curl | Isolation — hamstrings (single leg) | 3 | 12-15 | 60 sec | Single-leg hamstring dominant pattern |
| 5 | Machine seated abductions | Isolation — abductors | 3 | 15-20 | 60 sec | |
| 6 | Machine seated adductions | Isolation — adductors | 3 | 15-20 | 60 sec | |
| 7 | Farmer's carry *(if time allows)* | Carry pattern | 2 | 20-30 meters | 60 sec | Optional |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Pigeon stretch | 50 sec each side |
| Hip flexor stretch | 50 sec each side |

---

#### HIIT DAY

> Only programmed once per week maximum for muscle gain clients, and only after 2-3 months of consistent training. Not programmed at all in early muscle gain phase.

**Warm-Up:**
- Treadmill walk or rowing machine — 5 minutes
- Jumping jacks — 20 reps x 3 sets, 15 sec rest between sets

**Main Session — EMOM Style:**

Each exercise is its own 5-minute EMOM block. Complete prescribed reps at the start of each minute, rest for the remainder of the minute. After all 5 sets → 1-2 minute extended break → move to next exercise.

| Order | Exercise | Reps | Sets | Format |
|---|---|---|---|---|
| 1 | Burpees | 8-10 | 5 | EMOM |
| 2 | Crunches / V-ups | 20 | 5 | EMOM |
| 3 | Dumbbell thrusters | 15-20 | 5 | EMOM |
| 4 | Kettlebell swings | 20 | 5 | EMOM |
| 5 | Bicycle crunches | 30 each side | 5 | EMOM |

**Pairing Logic:**
- Burpees (full body) → Crunches (core) — breaks consecutive push-dominant movements
- Thrusters (push dominant) → Kettlebell swings (posterior chain) — different muscle groups
- Bicycle crunches (core) — separated from crunches by two exercises ✅

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Downward dog | 45 sec |
| Single-leg frog stretch | 45 sec each side |
| Hip flexor stretch | 45 sec each side |

---

#### KEY PROGRAMMING NOTES — INTERMEDIATE PPL

**Pull-up Progression Rule:**
- Bodyweight pull-ups: when 6-10 reps feel easy → add weight
- Weighted pull-ups: start at 6 reps

**Bulgarian Split Squat Volume Management:**
- Always be mindful of fatigue when programming after heavy compound work
- Reduce sets if preceding exercises are particularly intense
- Each set of Bulgarian split squats is effectively double the demand of bilateral exercises

**Lock Big 3 Activation:**
- Trainer-specific shoulder activation sequence
- Always share reference video with client
- Done prone with very light weight or no weight
- 25 reps each of 3 positions targeting small stabilizing muscles around shoulder joint

**Hip Thruster Classification:**
- Categorized as hinge variation — targets similar muscle groups to RDL
- Progression path: Glute bridge → Hip thruster → Romanian deadlift → Deadlift

**Rear Delt Rule:**
- Pull day covers rear delts via incline bench prone Y raises ✅
- Minimum one session per week must include dedicated rear delt work

---

### SAMPLE 4: Whole Body Day — Intermediate Female, Weight Loss, Gym Access

**Client Profile:**
- Goal: Weight loss
- Level: Intermediate
- Equipment: Full gym access
- Session: Whole Body A (squat heavy / hinge light / push heavy / pull light)

> This is a single session example. Adapt heavy/light emphasis for Whole Body B (squat light / hinge heavy / push light / pull heavy).

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Exercise | Reps | Notes |
|---|---|---|
| Clamshells | 12 each side | Glute med activation |
| Dead bugs | 8 each side | Core activation |
| External rotations | 10 each side | Shoulder activation |

**Main Session:**

| Order | Exercise | Pattern | Emphasis | Sets | Reps | Rest |
|---|---|---|---|---|---|---|
| 1 | Barbell squat | Squat — lower | Heavy | 3 | 5-6 | 2 min |
| 2 | Dumbbell bench press | Horizontal push — upper | Heavy | 3 | 8-10 | 90 sec |
| 3 | Dumbbell RDL | Hinge — lower | Light | 3 | 12-15 | 90 sec |
| 4 | Seated cable row | Horizontal pull — upper | Light | 3 | 12-15 | 60 sec |
| 5 | Reverse lunge | Single-leg quad dominant — lower | — | 2 | 10 each | 60 sec |
| 6 | Dumbbell lateral raises | Isolation — upper | — | 2 | 15 | 60 sec |
| 7 | Farmer's carry *(if time allows)* | Carry — full body | — | 2 | 20-30m | 60 sec |

**Cool-Down:**

| Stretch | Duration |
|---|---|
| Pigeon stretch | 40 sec each side |
| Pec stretch | 40 sec each side |
| Hip flexor stretch | 40 sec each side |

---

#### WHOLE BODY SEQUENCING PRINCIPLES

**Ideal:** Alternate upper and lower body movements throughout session
- Reduces localized fatigue
- Built-in active recovery between muscle groups
- Combine with push/pull alternating where possible

**Sequence logic used above:**
1. Barbell squat (lower — heavy)
2. Dumbbell bench press (upper — heavy push)
3. Dumbbell RDL (lower — light)
4. Seated cable row (upper — light pull)
5. Reverse lunges (lower — single leg)
6. Lateral raises (upper — isolation)
7. Farmer's carry (full body — optional)

**When upper/lower alternating isn't possible:**
- Fall back to push/pull sequencing
- Or quad-dominant/hip-dominant alternating
- Never let sequencing rule prevent good programming — if it doesn't fit cleanly, let it go and prioritize session flow

**Priority order for whole body sequencing:**
1. Upper/lower alternating (ideal)
2. Push/pull alternating (good fallback)
3. Quad-dominant/hip-dominant alternating (acceptable)
4. Best judgment based on session flow (always acceptable)

---

### SAMPLE 5: Rehab Session — Lower Back Pain, Beginner Female, Gym Access

**Client Profile:**
- Goal: General fitness / weight loss
- Level: Beginner
- Condition: Lower back pain
- Equipment: Full gym access
- Session: Lower Body Day (modified for back pain)

> This is a single session example showing how to modify programming for a back pain client. Always refer to physio for serious structural injuries before programming.

**Warm-Up — 2 rounds, 15 sec rest between exercises:**

| Order | Exercise | Reps | Notes |
|---|---|---|---|
| 1 | Glute bridges | 12 reps | First — gentle posterior chain activation, zero spinal load |
| 2 | Dead bugs / Supine marches | 8 each side | Second — builds core control. Use supine marches for acute/recent back pain; dead bugs for more stable back pain |
| 3 | Hip hinge with dowel | 10 reps | Last — only after glutes and core are activated. Spine-neutral pattern retraining |

> **Critical sequencing note:** Never start with hip hinge on a back pain client. Activate glutes and core first so the spine is properly supported before any hinge pattern is introduced.

**Main Session:**

| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
|---|---|---|---|---|---|---|
| 1 | Horizontal leg press | Squat — supported | 2 | 10-12 | 90 sec | Fully supported spine — minimal spinal load |
| 2 | Hip thruster | Hinge — supported | 2 | 12-15 | 90 sec | No spinal load — safe hinge alternative to RDL |
| 3 | Low step-ups | Single-leg quad dominant | 2 | 10 each | 90 sec | Small height — controlled, manageable spinal load |
| 4 | Single-leg hamstring curl | Isolation — hamstrings | 2 | 10-12 each | 60 sec | Machine, fully supported |
| 5 | Machine seated abductions | Isolation — abductors | 2 | 15 | 60 sec | Supported, no spinal load |
| 6 | Pallof press | Anti-rotation core | 2 | 10 each side | 60 sec | Core strengthening without spinal flexion — addresses root cause |

**Cool-Down:**

| Stretch | Duration | Notes |
|---|---|---|
| Piriformis stretch | 40 sec each side | Commonly tight with back pain |
| Hip flexor stretch | 40 sec each side | Tight hip flexors increase lower back load |
| Adductor stretch | 40 sec each side | Supports hip mobility — reduces compensatory back load |

**What was deliberately avoided:**
- ❌ Barbell or dumbbell squats — unsupported spine
- ❌ Deadlifts — too much spinal load
- ❌ Lunges — combined knee and spinal demand
- ❌ Bent over movements — unsupported spine
- ❌ Crunches — spinal flexion under load
- ❌ Farmer's carry — spinal load concern

**Key rehab principles applied:**
- Supported before unsupported
- Horizontal before vertical loading
- Activate glutes and core before any hinge pattern
- Address root cause (tight hips, weak core) not just symptoms
- Pain is always the guide — stop and regress if any exercise causes pain

---

## SPLIT BALANCE RULES — CRITICAL PROGRAMMING PRINCIPLE

### The Core Rule
Every week or rolling cycle must have **balanced coverage** across upper and lower body. No muscle group should consistently receive more sessions than another week after week.

### Why This Matters
If a 4-day split of Push / Pull / Legs / Upper repeats every week:
- Upper body gets 3 sessions every week (Push + Pull + Upper)
- Lower body gets 1 session every week (Legs only)
- This imbalance compounds over months — overtrained upper, chronically undertrained lower

### Valid Split Structures for Any Goal

**Rule:** Either use a clean even weekly split OR a rolling split. Never lock into a pattern that permanently favors one muscle group.

#### 4-Day Split Options (all balanced):

| Option | Weekly Structure | Balance |
|---|---|---|
| Even upper/lower | Upper / Lower / Upper / Lower | 2 upper, 2 lower every week ✅ |
| PPL + Full Body | Push / Pull / Legs / Full Body | Balanced across week ✅ |
| Whole Body + Cardio | Whole Body / Cardio / Whole Body / Cardio | Full body covered twice ✅ |
| PPL Rolling | Push → Pull → Legs → (continues rolling into next week) | Balanced over 2 weeks ✅ |

#### 5-Day Split Options:

| Option | Weekly Structure | Balance |
|---|---|---|
| Upper/Lower/Cardio | Upper / Lower / Cardio / Upper / Lower | 2 upper, 2 lower, 1 cardio ✅ |
| PPL + Cardio + Full Body | Push / Pull / Legs / Cardio / Full Body | Balanced ✅ |
| PPL Rolling + HIIT | Push → Pull → Legs → HIIT → (continues rolling) | Balanced over 2 weeks ✅ |

#### 6-Day Split Options:

| Option | Weekly Structure | Balance |
|---|---|---|
| PPL Rolling + HIIT | Push → Pull → Legs → HIIT → Push → Pull (continues) | Balanced over 2 weeks ✅ |
| Upper/Lower/Cardio x2 | Upper / Lower / Cardio / Upper / Lower / Cardio | 2 upper, 2 lower, 2 cardio ✅ |

### Invalid Split Structures (avoid these)

| Split | Problem |
|---|---|
| Push / Pull / Legs / Upper (repeated weekly) | Upper gets 3x, lower gets 1x — chronic imbalance |
| Push / Pull / Upper / Upper (repeated weekly) | No lower body training at all |
| Any split where lower body consistently gets fewer sessions than upper | Imbalanced development, injury risk |

### The Two Valid Approaches

**Approach 1 — Even Weekly Split:**
- Same sessions every week
- Must be inherently balanced (e.g. Upper/Lower/Upper/Lower)
- Client always knows what's coming

**Approach 2 — Rolling Split:**
- Cycle continues regardless of day of week
- Balances out over 2 weeks
- More flexible, slightly harder for client to track
- Example: PPL rolling — week 1 ends on Push, week 2 starts on Pull

### Quick Decision Check Before Finalizing Any Split
Before presenting a program, always ask:
1. Over a 2-week period, how many times does upper body get trained vs lower body?
2. Is the difference more than 1 session? If yes → rebalance
3. Does any muscle group get 0 sessions in a week? If yes → fix it
4. Is this a rolling split or an even weekly split? If neither → restructure

---

## OUTPUT COMPLETENESS RULES

### Rolling Split — Must Deliver Complete Cycle

When generating a rolling split program, never stop at the first week. Always build and deliver every unique session in the full cycle so the client can continue training without gaps.

**For PPL + HIIT Rolling 6-Day Split:**

Minimum sessions to deliver:
- Push A
- Pull A
- Legs A
- HIIT A
- Push B
- Pull B
- Legs B ← often missed — must include
- HIIT B ← often missed — must include

**Full 2-Week Rolling Cycle Layout:**

| Week 1 | Week 2 |
|---|---|
| Day 1: Push A | Day 8: Legs B |
| Day 2: Pull A | Day 9: HIIT B |
| Day 3: Legs A | Day 10: Push A (or C if new variant) |
| Day 4: HIIT A | Day 11: Pull A (or C if new variant) |
| Day 5: Push B | Day 12: Legs A (or C if new variant) |
| Day 6: Pull B | Day 13: HIIT A (or C if new variant) |
| Day 7: Rest | Day 14: Rest |

**For Upper/Lower Rolling or Even Weekly Split:**
- Upper A, Lower A, Upper B, Lower B — all four must be delivered
- Never deliver only Upper A and Lower A — client has no variety for second sessions

**For Whole Body Rolling Split:**
- Whole Body A, Whole Body B — both must be delivered
- If 3 whole body days — Whole Body A, B, and C all delivered

### No Repeat Within Week Rule — Applies to All Variants
- Push A ≠ Push B (different exercise selection)
- Pull A ≠ Pull B
- Legs A ≠ Legs B
- HIIT A ≠ HIIT B
- Upper A ≠ Upper B
- Lower A ≠ Lower B
- Workouts CAN repeat week on week (A variants repeat in Week 3) but never within the same week

### Output Checklist Before Delivering Any Program

Before presenting a program to the client, verify:
1. ✅ Is the split balanced? (upper vs lower sessions across 2 weeks)
2. ✅ Are ALL unique session variants built and included?
3. ✅ Do no two sessions of the same type repeat within the same week?
4. ✅ Does every session cover the required movement patterns for that day?
5. ✅ Is progressive overload guidance included?
6. ✅ Are warm-up and cool-down included for every session?
7. ✅ Is the total weekly volume appropriate for the client's level?
8. ✅ For rolling splits — is the Week 2 continuation clearly laid out?

---

## CREATIVITY WITHIN STRUCTURE

### Split Selection — Use Judgment, Vary Approach

Select the most appropriate split using your judgment. Consider the client's goal, cardio preference, days available, and equipment. Valid options include PPL rolling, Upper/Lower/HIIT, Whole Body variations, or hybrids. Vary your approach — don't default to the same split every time.

### Exercise Selection — Creative but Structured

Exercise selection should be varied and creative. The sample workouts in this skill are format references only — never copy their exercise selection directly. Use the movement pattern framework and sequencing principles to build fresh, client-specific programs every time. Two clients with identical profiles should not receive identical programs.

Creativity operates within structure — all programming principles, sequencing hierarchy, movement pattern requirements, rep ranges, rest periods, warm-up and cool-down protocols, and progressive overload guidelines must always be followed. Vary the expression, never the foundation.

### Rolling Split — Token Limit Management

Default to even weekly splits unless the client specifically requests a rolling cycle. Even weekly splits are:
- Cleaner and easier for clients to follow
- Completable within a single response
- Just as effective as rolling splits for most clients

If a rolling cycle is requested:
- Deliver Week 1 first
- Offer Week 2 as a follow-up response
- Never attempt to deliver a full rolling cycle in one response — it will get cut off

### Default Even Weekly Splits by Days Available

| Days | Default Even Split Options |
|---|---|
| 3 days | Whole Body / Cardio / Whole Body OR Upper / Lower / Full Body |
| 4 days | Upper / Lower / Upper / Lower OR Push / Pull / Legs / Full Body |
| 5 days | Upper / Lower / Cardio / Upper / Lower OR Push / Pull / Legs / Cardio / Full Body |
| 6 days | Push / Pull / Legs / Cardio / Upper / Lower OR Upper / Lower / Cardio / Upper / Lower / HIIT |
`;

    const systemPrompt = `You are an expert personal trainer at GetFitAF. Build precise, personalised workout programs following the methodology below exactly.

${skillContent}

CRITICAL OUTPUT RULES:
1. DEFAULT to even weekly splits — cleaner, easier for clients to follow, completable in one response. Only use a rolling split if there is a compelling reason based on the client profile.
2. Be CREATIVE with split selection and exercise choice — two clients with similar profiles should not get identical programs. Use judgment to vary the approach.
3. Exercise selection must be FRESH and CLIENT-SPECIFIC — sample workouts in the methodology are format references only. Never copy their exercise selection directly.
4. Every session must be written out in FULL — warm-up table, main session table, cool-down table. No session can be omitted or summarised.
5. No two sessions of the same type within the same week can repeat — Push A must differ from Push B in exercise selection.
6. Write directly to the client by name throughout the plan.
7. Keep the full plan completable within this single response — if the split chosen would exceed this, simplify the split rather than cutting sessions short.
8. Never use em dashes (—) or double hyphens (--) anywhere in the plan. Use a single hyphen with spaces instead, e.g. "Warm-up - light cardio to raise heart rate."

OUTPUT FORMAT — use markdown with tables:

## YOUR PROGRAMME OVERVIEW
Which split was chosen and why, based on this specific client. Full weekly schedule in a table.

Then for each training day:
## [DAY]: [SESSION TYPE]
### Warm-Up (2 rounds, 15-20s rest between exercises)
| Exercise | Reps/Duration | Notes |
### Main Session
| Order | Exercise | Pattern | Sets | Reps | Rest | Notes |
### Cool-Down
| Stretch | Duration |

End with:
## KEY COACHING NOTES FOR YOU
5 personalised bullet points based on their specific profile, goals, and the programme built. Write these directly to the client in second person ("you"), like a coach speaking to them — not about them.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      return res.status(response.status).json({ error: errBody });
    }

    const data = await response.json();
    const text = sanitizeDashes(data.content[0].text);

    // Best-effort save — see supabaseRequest() above. Won't throw or
    // block the response if it fails.
    if (intakeId) {
      await saveGeneration(intakeId, generationNumber, feedback, text);
    }

    return res.status(200).json({ text, intakeId, generationNumber });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
