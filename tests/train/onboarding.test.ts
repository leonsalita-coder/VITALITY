import { describe, it, expect } from 'vitest'
import {
  applyOnboarding, onboardingNeeded, anythingAnswered, startingWeightFor, availableEquipment,
} from '../../lib/train/onboarding'
import type { OnboardingAnswers, OnboardingState } from '../../lib/train/onboarding'
import { suggestTarget } from '../../lib/train/progression'
import { currentBodyweight } from '../../lib/train/bodyweight'

const TODAY = '2026-09-19'
const at = (d: string) => new Date(`${d}T12:00:00`).getTime()

const full: OnboardingAnswers = {
  bodyweightLb: 178,
  startingLifts: [
    { exerciseId: 'bench_press', weightLb: 155 },
    { exerciseId: 'back_squat', weightLb: 205 },
  ],
  equipment: ['Barbell', 'dumbbell', 'barbell'],
  avoid: ['overhead_press'],
  sessionsPerWeek: 3,
  trainingAge: 'beginner',
}

describe('an answered onboarding', () => {
  const { state, seeded } = applyOnboarding({}, full, TODAY)

  it('records bodyweight as a dated reading', () => {
    expect(currentBodyweight(state.bodyweight || [])).toBe(178)
    expect(seeded.bodyweight).toBe(true)
  })

  it('stores working weights WITHOUT inventing a session', () => {
    expect(startingWeightFor(state, 'bench_press')).toBe(155)
    // nothing that would count toward volume, streaks or records
    expect((state as Record<string, unknown>).history).toBeUndefined()
    expect((state as Record<string, unknown>).finishedDates).toBeUndefined()
  })

  it('takes equipment, de-duplicated and lower-cased', () => {
    expect(state.equipment).toEqual(['barbell', 'dumbbell'])
  })

  it('pre-sets the pain flags from what hurts', () => {
    expect(state.painFlagged).toContain('overhead_press')
  })

  it('sets the streak target from their stated frequency', () => {
    expect(state.weeklyTarget).toBe(3)
  })

  it('records training age', () => {
    expect(state.trainingAge).toBe('beginner')
  })

  it('reports what it actually took', () => {
    expect(seeded.lifts).toBe(2)
    expect(anythingAnswered(seeded)).toBe(true)
  })
})

describe('a real suggestion on session one', () => {
  it('suggests the weight they told us, with no history at all', () => {
    const { state } = applyOnboarding({}, full, TODAY)
    const s = suggestTarget([], {
      reps: 5,
      loading: 'barbell',
      lastKg: startingWeightFor(state, 'bench_press'),
    }, at(TODAY))
    expect(s.weight).toBe(155)
    expect(s.basis).toBe('new')
    expect(s.reason).toContain('155')
  })

  it('falls back to nothing useful when they skipped it — today’s behaviour', () => {
    const { state } = applyOnboarding({}, {}, TODAY)
    expect(startingWeightFor(state, 'bench_press')).toBeNull()
  })
})

describe('a fully skipped onboarding changes nothing', () => {
  const before: OnboardingState = { painFlagged: ['old_injury'] }
  const { state, seeded } = applyOnboarding(before, {}, TODAY)

  it('writes no field that was not answered', () => {
    expect(state.bodyweight).toBeUndefined()
    expect(state.startingWeights).toBeUndefined()
    expect(state.equipment).toBeUndefined()
    expect(state.weeklyTarget).toBeUndefined()
    expect(state.trainingAge).toBeUndefined()
  })

  it('leaves what was already there alone', () => {
    expect(state.painFlagged).toEqual(['old_injury'])
  })

  it('reports that nothing landed', () => {
    expect(anythingAnswered(seeded)).toBe(false)
  })

  it('still counts as asked, so it is not put again', () => {
    expect(onboardingNeeded(state)).toBe(false)
    expect(onboardingNeeded({})).toBe(true)
  })
})

describe('partial answers', () => {
  it('takes bodyweight alone', () => {
    const { state, seeded } = applyOnboarding({}, { bodyweightLb: 165 }, TODAY)
    expect(currentBodyweight(state.bodyweight || [])).toBe(165)
    expect(seeded.lifts).toBe(0)
    expect(state.weeklyTarget).toBeUndefined()
  })

  it('ignores an answer that is not usable', () => {
    const { state } = applyOnboarding({}, {
      bodyweightLb: 0,
      sessionsPerWeek: 99,
      trainingAge: 'god-tier' as never,
      startingLifts: [{ exerciseId: 'bench_press', weightLb: -5 }],
    }, TODAY)
    expect(state.bodyweight).toBeUndefined()
    expect(state.weeklyTarget).toBeUndefined()
    expect(state.trainingAge).toBeUndefined()
    expect(state.startingWeights).toBeUndefined()
  })

  it('merges pain flags rather than replacing them', () => {
    const { state } = applyOnboarding({ painFlagged: ['a'] }, { avoid: ['b'] }, TODAY)
    expect(state.painFlagged!.sort()).toEqual(['a', 'b'])
  })
})

describe('what is available today beats what is usually available', () => {
  it('prefers a same-day override — travel is the real failure case', () => {
    const out = availableEquipment({
      todayOverride: ['bodyweight'],
      stated: ['barbell', 'dumbbell'],
      fromHistory: ['barbell', 'machine'],
    })
    expect(out.equipment).toEqual(['bodyweight'])
    expect(out.source).toBe('today')
  })

  it('prefers what they stated over what history implies', () => {
    const out = availableEquipment({ stated: ['dumbbell'], fromHistory: ['barbell'] })
    expect(out.equipment).toEqual(['dumbbell'])
    expect(out.source).toBe('stated')
  })

  it('falls back to history, which is today’s behaviour', () => {
    const out = availableEquipment({ fromHistory: ['barbell'] })
    expect(out.source).toBe('history')
  })

  it('reports none rather than guessing', () => {
    expect(availableEquipment({}).source).toBe('none')
    expect(availableEquipment({ todayOverride: [] }).source).toBe('none')
  })
})
