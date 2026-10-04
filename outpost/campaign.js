// OUTPOST — campaign missions.
//
// Five hand-built boards, one per doctrine. A skirmish map is generated
// and point-symmetric so that a loss is never the map's fault; a mission
// is the exact opposite on purpose. The ground is lopsided, the brief is
// specific, and the doctrine you are handed is the way through. Terrain,
// lane shape and starting garrisons are all doing the teaching.
//
// Each mission is data only: a map spec for the engine's buildMap, an
// objective, the doctrine it hands you, and the difficulty of the
// opponent. Nothing here reaches into the simulation.
//
// Coordinates are in the engine's own 1000x640 space. The view scales
// the board to whatever screen it lands on, so these never need to care
// about pixels.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.OutpostCampaign = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NEUTRAL = 0, PLAYER = 1, ENEMY = 2;

  const MISSIONS = [
    // -----------------------------------------------------------------
    {
      id: "two-fronts",
      name: "Two Fronts",
      doctrine: "vanguard",
      difficulty: 1,
      brief:
        "Two listening posts, one on each horn of the system, and an " +
        "enemy with the numbers to press both at once. You cannot garrison " +
        "both heavily enough to simply hold. You can be in two places " +
        "nearly at once.",
      hint: "Vanguard fleets cross 25% faster. Hold with the fleet, not the garrison.",
      objective: { kind: "hold", nodeIds: [1, 2], holdFor: 45, seconds: 210 },
      goal: "Hold BOTH listening posts for 45 seconds without losing either.",
      // 0 your Command (centre) · 1,2 the two posts · 3,4 waypoints
      // 5 their staging · 6,7 their forward camps · 8,9 their factories
      map: {
        w: 1000, h: 640,
        nodes: [
          { x: 500, y: 250, type: "command", owner: PLAYER, garrison: 44 },
          { x: 70, y: 70, type: "relay", terrain: "asteroid", owner: PLAYER, garrison: 20 },
          { x: 930, y: 70, type: "relay", terrain: "asteroid", owner: PLAYER, garrison: 20 },
          { x: 330, y: 150, type: "factory", owner: PLAYER, garrison: 15 },
          { x: 670, y: 150, type: "factory", owner: PLAYER, garrison: 15 },
          { x: 500, y: 600, type: "command", owner: ENEMY, garrison: 60, level: 1 },
          { x: 120, y: 330, type: "factory", owner: ENEMY, garrison: 34, level: 1 },
          { x: 880, y: 330, type: "factory", owner: ENEMY, garrison: 34, level: 1 },
          { x: 500, y: 420, type: "mine", owner: NEUTRAL, garrison: 9 },
          { x: 170, y: 150, type: "relay", owner: PLAYER, garrison: 10 },
          { x: 830, y: 150, type: "relay", owner: PLAYER, garrison: 10 }
        ],
        // Each post is three hops out from the Command along its own arm,
        // and the arms do not touch. A round trip between them is most of
        // the width of the board twice over, which is the whole mission:
        // whichever post you are not at is the one under attack.
        lanes: [
          [0, 3], [0, 4], [3, 9], [4, 10], [9, 1], [10, 2], [0, 8],
          [1, 6], [2, 7], [6, 8], [7, 8], [6, 5], [7, 5], [8, 5]
        ]
      }
    },

    // -----------------------------------------------------------------
    {
      // The id changed when the mission was rebuilt: a clear recorded for
      // the old one (hold the middle of a cut board) would otherwise show
      // as a clear of this one.
      id: "meridian-yard",
      name: "The Waist",
      doctrine: "logistics",
      difficulty: 0,
      brief:
        "Anchorage is safe and the Doomstar in it is intact, but every Relay " +
        "that could charge it is in the Annex, on the far side of the " +
        "Meridian Yard \u2014 and the Freight Combine runs ninety hulls " +
        "across the Yard on a timetable. While they dock nothing you can " +
        "mass will take it, and when they land on a position of yours it " +
        "falls. The Yard is never yours for long. It is empty for a few " +
        "seconds at a time.",
      hint: "The bar under the toolbar counts the Yard's timetable. Take the Yard when it opens, cross, take the Annex, and its Relays charge the Doomstar for as long as the Yard stays yours. Deep Logistics keeps the Annex producing at 90% while it is cut off. Then shoot the Hub: it is garrisoned past anything a fleet can break.",
      // The Combine only runs freight; it does not come looking for you.
      // Without this the opponent routine retakes the Yard the moment it
      // is empty, and the timetable stops being the puzzle.
      posture: "static",
      objective: { kind: "capture", nodeId: 11, seconds: 600 },
      goal: "Capture the Rail Hub within 10 minutes. Fleets alone cannot break it.",
      script: {
        convoys: [
          // Two freight runs a minute apart-ish, in opposite directions,
          // staggered so the Yard is open about two seconds in three.
          { id: "north", name: "North freight", from: 11, to: 5, onward: 12,
            count: 90, dwell: 8, first: 14, every: 48 },
          { id: "south", name: "South freight", from: 12, to: 5, onward: 11,
            count: 90, dwell: 8, first: 38, every: 48 }
        ],
        dispatches: [
          { at: 1, tone: "story",
            text: "ANCHORAGE \u2014 The Doomstar is intact and cold. Its Relay field is in the Annex, beyond the Meridian Yard." },
          { at: 7, tone: "story",
            text: "Combine freight crosses the Yard on a timetable: ninety hulls, docked eight seconds, then onward." },
          { at: 15, tone: "warn",
            text: "North freight is landing. Do not be standing in the Yard." },
          { at: 90, tone: "story",
            text: "The Hub is garrisoned far beyond what fleets can break. Charge the Doomstar and shoot it." }
        ]
      },
      // 0 Anchorage (your Command) · 1 the Doomstar · 2 Foundry · 3 Ore Dock
      // 4 Gatehouse · 5 THE YARD · 6 East Gate · 7,8,9 Annex Relays · 10 Annex Foundry
      // 11 Rail Hub (dug into the belt) · 12 Combine Command · 13,14 their outliers
      map: {
        w: 1000, h: 640,
        nodes: [
          { name: "Anchorage", x: 90, y: 320, type: "command", owner: PLAYER, garrison: 30 },
          { name: "Doomstar", x: 250, y: 320, type: "doomstar", owner: PLAYER, garrison: 24 },
          { name: "Foundry", x: 190, y: 150, type: "factory", owner: PLAYER, garrison: 16 },
          { name: "Ore Dock", x: 190, y: 490, type: "mine", owner: PLAYER, garrison: 10 },
          { name: "Gatehouse", x: 400, y: 320, type: "factory", owner: PLAYER, garrison: 20 },
          { name: "Meridian Yard", x: 520, y: 320, type: "factory", owner: ENEMY, garrison: 4 },
          { name: "East Gate", x: 640, y: 320, type: "factory", owner: NEUTRAL, garrison: 8 },
          { name: "Annex Relay A", x: 760, y: 170, type: "relay", owner: NEUTRAL, garrison: 9 },
          { name: "Annex Relay B", x: 760, y: 470, type: "relay", owner: NEUTRAL, garrison: 9 },
          { name: "Annex Relay C", x: 890, y: 320, type: "relay", owner: NEUTRAL, garrison: 10 },
          { name: "Annex Foundry", x: 770, y: 320, type: "factory", owner: NEUTRAL, garrison: 8 },
          { name: "Rail Hub", x: 520, y: 110, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 235 },
          { name: "Combine Command", x: 520, y: 540, type: "command", owner: ENEMY, garrison: 60 },
          { name: "North Battery", x: 720, y: 70, type: "factory", owner: ENEMY, garrison: 30 },
          { name: "South Battery", x: 720, y: 580, type: "factory", owner: ENEMY, garrison: 30 }
        ],
        // The Yard (5) is the only way anywhere: Gatehouse reaches it from
        // the west, the East Gate from the east, and the Hub and the
        // Combine's Command hang off its other two sides. The Annex is a dead end
        // behind the Gate, which is why nobody bothers to guard it.
        lanes: [
          [0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 4],
          [4, 5], [5, 6], [5, 11], [5, 12],
          [6, 7], [6, 8], [6, 10], [7, 10], [8, 10], [10, 9], [7, 9], [8, 9],
          [11, 13], [12, 14]
        ]
      }
    },

    // -----------------------------------------------------------------
    {
      id: "siege",
      name: "The Redoubt Gate",
      doctrine: "relays",
      difficulty: 0,
      brief:
        "Their command sits behind a belt of asteroids garrisoned in the " +
        "hundreds, each one worth a quarter again in defence. They will " +
        "not come out and you cannot go through \u2014 not with fleets. " +
        "There is another way to hit something.",
      hint: "Take the centre, then fire the Doomstar at the WALL, not at their Command \u2014 the wall is already over its cap, so every point of damage is permanent.",
      // A fortress defends. Without this the AI reads three 70-unit
      // walls as an attack force and marches them into the player's
      // home, which is the opposite of the mission.
      posture: "defend",
      objective: { kind: "capture", nodeId: 9, seconds: 360 },
      goal: "Capture the enemy Command within 6 minutes.",
      // 0 home · 1,2,3 relays (dense, yours to hold) · 4 DOOMSTAR
      // 5,6,7,8 their asteroid wall · 9 their Command, upgraded
      map: {
        w: 1000, h: 640,
        nodes: [
          { x: 100, y: 320, type: "command", owner: PLAYER, garrison: 36 },
          { x: 250, y: 140, type: "relay", owner: PLAYER, garrison: 12 },
          { x: 250, y: 500, type: "relay", owner: PLAYER, garrison: 12 },
          { x: 330, y: 320, type: "relay", owner: NEUTRAL, garrison: 10 },
          { x: 500, y: 320, type: "doomstar", owner: NEUTRAL, garrison: 18 },
          { x: 660, y: 140, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 245, level: 2 },
          { x: 660, y: 500, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 245, level: 2 },
          { x: 700, y: 320, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 249, level: 2 },
          { x: 500, y: 560, type: "mine", owner: NEUTRAL, garrison: 8 },
          { x: 900, y: 320, type: "command", terrain: "open", owner: ENEMY, garrison: 185, level: 1 }
        ],
        lanes: [
          [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [2, 8], [3, 4], [8, 4],
          [4, 5], [4, 6], [4, 7], [5, 7], [6, 7], [5, 9], [6, 9], [7, 9]
        ]
      }
    },

    // -----------------------------------------------------------------
    {
      id: "deep-seam",
      name: "Deep Seam",
      doctrine: "prospectors",
      difficulty: 0,
      brief:
        "They have the factories and they will always have more ships than " +
        "you. What they do not have is the seam running through the middle " +
        "of this system. Money is a weapon if you spend it fast enough.",
      hint: "Prospectors earns 70% more and researches 30% cheaper. Buy Assault, then take the seam.",
      objective: { kind: "hold", nodeType: "mine", holdFor: 25, seconds: 270 },
      goal: "Hold every Mine on the map at once for 30 seconds.",
      // 0 home · 1 your factory · 2,3,4,5 the seam (mines, contested)
      // 6 their Command · 7,8 their factories (out-producing you)
      map: {
        w: 1000, h: 640,
        nodes: [
          { x: 120, y: 320, type: "command", owner: PLAYER, garrison: 38 },
          { x: 250, y: 320, type: "factory", owner: PLAYER, garrison: 18 },
          { x: 230, y: 120, type: "factory", owner: PLAYER, garrison: 14 },
          { x: 430, y: 130, type: "mine", terrain: "well", owner: NEUTRAL, garrison: 9 },
          { x: 430, y: 520, type: "mine", terrain: "well", owner: NEUTRAL, garrison: 9 },
          { x: 600, y: 230, type: "mine", owner: NEUTRAL, garrison: 12 },
          { x: 600, y: 430, type: "mine", owner: NEUTRAL, garrison: 12 },
          { x: 900, y: 320, type: "command", owner: ENEMY, garrison: 30 },
          { x: 760, y: 150, type: "factory", owner: ENEMY, garrison: 15 },
          { x: 760, y: 490, type: "factory", owner: ENEMY, garrison: 15 },
          { x: 500, y: 320, type: "relay", owner: NEUTRAL, garrison: 8 }
        ],
        // 0 home · 1,2 your factories · 3,4,5,6 the seam · 7 their Command
        // 8,9 their factories · 10 the relay in the middle of the seam
        lanes: [
          [0, 1], [0, 2], [2, 3], [1, 10], [1, 4], [3, 10], [4, 10],
          [3, 5], [4, 6], [10, 5], [10, 6], [5, 8], [6, 9], [8, 7], [9, 7], [8, 9]
        ]
      }
    },

    // -----------------------------------------------------------------
    {
      id: "redoubt",
      name: "Hard Shell",
      doctrine: "shock",
      difficulty: 0,
      brief:
        "A dug-in opponent on good ground, researched into defence before " +
        "you arrived. Every position of theirs fights at a premium and the " +
        "longer this runs the worse it gets for you. Hit it now, hit it hard.",
      hint: "Shock Troops assault 15% harder. Mass everything; do not trade slowly.",
      objective: { kind: "capture", nodeId: 8, seconds: 240 },
      goal: "Capture the enemy Command within 4 minutes.",
      // Everything of theirs is on asteroid terrain and pre-fortified.
      foeTech: { assault: 0, fortify: 3 },
      map: {
        w: 1000, h: 640,
        nodes: [
          { x: 110, y: 200, type: "command", owner: PLAYER, garrison: 52 },
          { x: 110, y: 460, type: "factory", owner: PLAYER, garrison: 30 },
          { x: 300, y: 330, type: "factory", owner: PLAYER, garrison: 26, level: 1 },
          { x: 470, y: 160, type: "mine", owner: NEUTRAL, garrison: 8 },
          { x: 470, y: 500, type: "mine", owner: NEUTRAL, garrison: 8 },
          { x: 620, y: 330, type: "relay", terrain: "asteroid", owner: ENEMY, garrison: 34 },
          { x: 760, y: 150, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 45, level: 1 },
          { x: 760, y: 510, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 45, level: 1 },
          { x: 920, y: 330, type: "command", owner: ENEMY, garrison: 72, level: 2 }
        ],
        lanes: [
          [0, 2], [1, 2], [0, 1], [2, 3], [2, 4], [3, 5], [4, 5],
          [3, 6], [4, 7], [5, 6], [5, 7], [6, 8], [7, 8], [5, 8]
        ]
      }
    },

    // -----------------------------------------------------------------
    {
      id: "last-light",
      name: "Last Light",
      doctrine: "relays",
      difficulty: 0,
      brief:
        "Beacon Station is the last uplink in the sector and the Array " +
        "beside it is the last weapon. A relief fleet is six minutes out. " +
        "The Combine has three staging depots on the far ridge and it " +
        "launches a wave from each on a timetable, every one bigger than " +
        "the last, and every wave keeps going after it lands. You will " +
        "not hold all three posts. You do not have to: a wave is only as " +
        "big as the depot it was drawn from.",
      hint: "The strip under the toolbar names the depot filling next and how many hulls it will launch. Forward Relays charges the Array twice as fast: shoot a depot while it fills and the wave is that much smaller, then take the empty depot and it never launches again.",
      posture: "static",
      objective: { kind: "survive", seconds: 420, keep: [0, 1] },
      goal: "Hold Beacon Station and the Array for 7 minutes.",
      script: {
        convoys: [
          // Staggered by a quarter of the cycle so there is always one
          // wave to answer and never three at once. Each wave lands on a
          // post, then pushes on toward whatever sits behind it.
          { id: "ridge", name: "Ridge wave", label: "Ridge", from: 7, to: 4, onward: 2,
            count: 56, grow: 8, dwell: 6, first: 40, every: 80, draw: true },
          { id: "mid", name: "Mid wave", label: "Mid", from: 8, to: 5, onward: 1,
            count: 56, grow: 8, dwell: 6, first: 65, every: 80, draw: true },
          { id: "deep", name: "Deep wave", label: "Deep", from: 9, to: 6, onward: 3,
            count: 56, grow: 8, dwell: 6, first: 90, every: 80, draw: true }
        ],
        dispatches: [
          { at: 1, tone: "story",
            text: "BEACON STATION \u2014 Relief is six minutes out. Hold the station and the Array until it arrives." },
          { at: 8, tone: "story",
            text: "Combine depots on the ridge are filling. Each launches a wave when its timer runs out." },
          { at: 30, tone: "warn",
            text: "First wave in ten seconds. Ridge Depot. Reinforce the Ridge Post or shoot the depot." },
          { at: 150, tone: "story",
            text: "A depot that launches is empty for a moment. Take it and it never launches again." }
        ]
      },
      // 0 Beacon Station · 1 the Array (Doomstar) · 2,3 your Relays
      // 4,5,6 forward posts · 7,8,9 their depots
      map: {
        w: 1000, h: 640,
        nodes: [
          { name: "Beacon Station", x: 110, y: 320, type: "command", owner: PLAYER, garrison: 40 },
          { name: "The Array", x: 330, y: 320, type: "doomstar", owner: PLAYER, garrison: 22 },
          { name: "North Relay", x: 230, y: 140, type: "relay", owner: PLAYER, garrison: 16 },
          { name: "South Relay", x: 230, y: 500, type: "relay", owner: PLAYER, garrison: 16 },
          { name: "Ridge Post", x: 560, y: 130, type: "factory", owner: PLAYER, garrison: 24 },
          { name: "Mid Post", x: 580, y: 320, type: "factory", owner: PLAYER, garrison: 24 },
          { name: "Deep Post", x: 560, y: 510, type: "factory", owner: PLAYER, garrison: 24 },
          { name: "Ridge Depot", x: 880, y: 100, type: "factory", owner: ENEMY, garrison: 60, level: 3 },
          { name: "Mid Depot", x: 910, y: 320, type: "factory", owner: ENEMY, garrison: 60, level: 3 },
          { name: "Deep Depot", x: 880, y: 540, type: "factory", owner: ENEMY, garrison: 60, level: 3 },
          { name: "Combine Command", x: 990, y: 320, type: "command", owner: ENEMY, garrison: 80 }
        ],
        // Each depot touches exactly one post, so a wave's target is never
        // in doubt. The posts are linked so a garrison can swing between
        // them, and each hangs off the line behind it.
        lanes: [
          [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [1, 5], [2, 4], [3, 6],
          [4, 5], [5, 6], [4, 7], [5, 8], [6, 9], [7, 10], [8, 10], [9, 10]
        ]
      }
    }

  ];

  function byId(id) {
    for (const m of MISSIONS) if (m.id === id) return m;
    return null;
  }

  // The same board turned on its side. Missions are drawn landscape, and
  // on a portrait phone a landscape board fits to a third of the screen
  // width; turning it (x and y swapped, nothing else) fills the screen and
  // changes nothing the simulation can see -- every distance, lane and
  // index is the same, so a mission plays identically either way.
  function transposed(map) {
    return {
      w: map.h, h: map.w,
      nodes: map.nodes.map((n) => Object.assign({}, n, { x: n.y, y: n.x })),
      lanes: map.lanes
    };
  }

  // Everything createGame needs for this mission, in one object. Pass
  // `portrait` to get the board turned for a tall screen.
  function optionsFor(mission, portrait) {
    return {
      map: portrait ? transposed(mission.map) : mission.map,
      objective: mission.objective,
      doctrine: mission.doctrine,
      foeDoctrine: mission.foeDoctrine || "standard",
      difficulty: mission.difficulty === undefined ? 1 : mission.difficulty,
      missionId: mission.id,
      foeTech: mission.foeTech || null,
      posture: mission.posture || "normal",
      script: mission.script || null,
      ascension: 0
    };
  }

  return { MISSIONS, byId, optionsFor, transposed };
});
