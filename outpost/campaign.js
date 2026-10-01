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
      id: "the-waist",
      name: "The Waist",
      doctrine: "logistics",
      difficulty: 0,
      brief:
        "Your holdings are two clusters joined by a single crossing, and " +
        "the enemy sits on top of it. They will cut you in half, probably " +
        "more than once. Most commanders would watch the far side go dark.",
      hint: "Deep Logistics keeps a severed position at 90% output. Let them cut it.",
      objective: { kind: "eliminate" },
      goal: "Take every enemy position. Expect to fight it cut in half.",
      // 0 home Command · 1,2 near cluster · 3 THE WAIST · 4,5,6 far cluster
      // 7 their Command · 8,9,10 theirs, all adjacent to the waist
      map: {
        w: 1000, h: 640,
        nodes: [
          { x: 120, y: 320, type: "command", owner: PLAYER, garrison: 32 },
          { x: 230, y: 170, type: "factory", owner: PLAYER, garrison: 14 },
          { x: 230, y: 470, type: "mine", owner: PLAYER, garrison: 10 },
          { x: 440, y: 320, type: "relay", terrain: "well", owner: PLAYER, garrison: 10 },
          { x: 640, y: 150, type: "factory", owner: PLAYER, garrison: 12 },
          { x: 640, y: 490, type: "mine", owner: PLAYER, garrison: 10 },
          { x: 700, y: 320, type: "factory", owner: NEUTRAL, garrison: 10 },
          { x: 920, y: 320, type: "command", owner: ENEMY, garrison: 55 },
          { x: 440, y: 110, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 26 },
          { x: 440, y: 530, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 26 },
          { x: 860, y: 120, type: "mine", owner: ENEMY, garrison: 16 },
          { x: 860, y: 520, type: "mine", owner: ENEMY, garrison: 16 }
        ],
        // Node 3 is the only link between the two halves, and 8 and 9 are
        // both one hop from it. Losing it is a matter of time.
        lanes: [
          [0, 1], [0, 2], [1, 3], [2, 3],
          [3, 4], [3, 5], [4, 6], [5, 6], [6, 7],
          [8, 3], [9, 3], [8, 1], [9, 2],
          [7, 10], [7, 11], [10, 4], [11, 5], [8, 10], [9, 11]
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
    }
  ];

  function byId(id) {
    for (const m of MISSIONS) if (m.id === id) return m;
    return null;
  }

  // Everything createGame needs for this mission, in one object.
  function optionsFor(mission) {
    return {
      map: mission.map,
      objective: mission.objective,
      doctrine: mission.doctrine,
      foeDoctrine: mission.foeDoctrine || "standard",
      difficulty: mission.difficulty === undefined ? 1 : mission.difficulty,
      missionId: mission.id,
      foeTech: mission.foeTech || null,
      posture: mission.posture || "normal",
      ascension: 0
    };
  }

  return { MISSIONS, byId, optionsFor };
});
