// The band above the prompt: limits, context and session rows, linked tasks, the buttons and their panels.

import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  LinkProps,
  RenderElement,
  SvgProps,
  TextProps,
} from 'claude-code'
import type { ContextFill, LimitRow, LinearTask, Panel, RetroRun, Tokens } from '../types'
import { STAGE_GLYPHS, STAGE_ICON_PX, barSvg, cells, contextBarSvg, limitLine, sideLine, stageIconSvg, textBar } from './draw'
import { fmtCompact, fmtMinutes, fmtResetAt, fmtResetIn, fmtTokens } from './format'
import { RECAP_TITLE } from './runs'
import { SETTINGS, type Part, type Shown } from './settings'
import { STAGES, stageStatuses, type StageStatus } from './stages'
import {
  BAR_HEIGHT,
  LABELS,
  PANEL_BG_HEX,
  SMART_MAX,
  SPARK_HEX,
  TRACK_HEX,
  ZONE_HEX,
  ZONE_LABEL,
  contextZone,
} from './theme'

/** What the band shows, read from the state as it is drawn. */
export type BandData = {
  isTerminal: boolean
  columns: number
  limits: readonly LimitRow[]
  tokens: Tokens
  costUsd: number | null
  /** The clock the reset countdowns count from. */
  at: number
  thinkMs: number
  context: ContextFill
  compactAt: number | undefined
  panel: Panel
  stagesUsed: readonly string[]
  tasks: readonly LinearTask[]
  recap: RetroRun
  pr: RetroRun
  recentSkills: readonly string[]
  projectSkills: readonly string[]
  shown: Shown
}

/** What the band's buttons do. */
export type BandActions = {
  /** Opens a panel, closing any other; pressed again, closes it. */
  toggle: (which: Panel) => Promise<unknown>
  togglePane: (which: 'retro' | 'pr') => Promise<unknown>
  insertSkill: (name: string) => Promise<unknown>
  setShown: (part: Part, value: boolean) => Promise<unknown>
  closePanel: () => Promise<unknown>
}

/** The surface's elements the band is drawn with; `Svg` where the surface draws images. */
export type BandElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Link: ElementConstructor<LinkProps>
  Svg?: ElementConstructor<SvgProps>
}

function hasTop(d: BandData): boolean {
  return d.shown.limits || d.shown.context || d.shown.session
}

function hasBottom(d: BandData): boolean {
  return d.tasks.length > 0 || d.shown.buttons || d.panel === 'settings'
}

/** Everything hidden and no task linked: the band steps aside (/usage-band brings Settings back). */
export function isBandEmpty(d: BandData): boolean {
  return !hasTop(d) && !hasBottom(d)
}

export function bandView(d: BandData, els: BandElements, act: BandActions): RenderElement {
  const { Box, Text, Button, Link } = els
  const { shown, panel: open } = d
  // Images where the surface draws them; the terminal gets glyphs.
  const Image = d.isTerminal ? undefined : els.Svg
  const panelBg = Image === undefined ? {} : { backgroundColor: PANEL_BG_HEX }
  const width = Math.max(8, Math.min(30, d.columns - 51))
  const t = d.tokens
  const totalIn = t.input + t.cacheRead + t.cacheWrite
  const ctx = d.context
  const ctxTokens = ctx.tokens ?? 0
  const zone = contextZone(ctxTokens, ctx.window, d.compactAt)
  const ctxPct = ctx.window > 0 ? (ctxTokens / ctx.window) * 100 : 0
  const limitRows = shown.limits ? d.limits : []

  const stageIcon = (status: StageStatus): RenderElement => {
    if (Image === undefined) {
      const color = status === 'done' ? 'success' : 'inactive'
      return <Text color={color} bold={status === 'done'}>{STAGE_GLYPHS[status]}</Text>
    }
    const alt = status === 'done' ? 'done' : status === 'skipped' ? 'ignored' : 'not reached'
    return <Image source={stageIconSvg(status, STAGE_ICON_PX)} alt={alt} width={STAGE_ICON_PX} height={STAGE_ICON_PX} />
  }

  const stagesPanel = (): RenderElement => {
    const statuses = stageStatuses(d.stagesUsed)
    const done = statuses.filter(s => s === 'done').length
    const skipped = statuses.filter(s => s === 'skipped').length
    return (
      <Box key="stages" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1} {...panelBg}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Workflow stage</Text>
          <Text dimColor>{`${done} of ${STAGES.length} used${skipped > 0 ? ` · ${skipped} ignored` : ''}`}</Text>
        </Box>
        {STAGES.map((stage, i) => {
          const status = statuses[i] ?? 'ahead'
          return (
            <Box key={`stage-${stage.skill}`} flexDirection="row" alignItems="center" gap={1}>
              <Box width={2}>
                <Text dimColor>{String(i + 1)}</Text>
              </Box>
              <Box key={`stage-icon-${stage.skill}-${status}`} width={2} alignItems="center">
                {stageIcon(status)}
              </Box>
              <Box width={17}>
                <Text bold={status === 'done'} dimColor={status === 'skipped'}>{`/${stage.skill}`}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {status === 'skipped' ? `ignored · ${stage.hint}` : stage.hint}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  const contextBar = (): RenderElement => {
    if (Image === undefined) {
      const c = cells(ctxPct, width)
      const tick = ctx.window > SMART_MAX ? Math.round((SMART_MAX / ctx.window) * width) : -1
      const rest = '─'.repeat(c.rest).split('')
      if (tick >= c.used && tick - c.used < rest.length) rest[tick - c.used] = '┆'
      return (
        <Box flexDirection="row">
          <Text color={ZONE_HEX[zone]}>{'━'.repeat(c.used)}</Text>
          <Text color={TRACK_HEX}>{rest.join('')}</Text>
        </Box>
      )
    }
    const px = width * 8
    return (
      <Image
        source={contextBarSvg(ctxTokens, ctx.window, px, d.compactAt)}
        alt={`context: ${fmtCompact(ctxTokens)} of ${fmtCompact(ctx.window)}, ${ZONE_LABEL[zone]}`}
        width={px}
        height={BAR_HEIGHT}
      />
    )
  }

  const drawBar = (r: LimitRow): RenderElement => {
    if (Image === undefined) return textBar(Box, Text, r, width)
    const px = width * 8
    return (
      <Image
        source={barSvg(r.percentUsed, px)}
        alt={`${LABELS[r.kind] ?? r.kind}: ${Math.round(r.percentUsed)}% used`}
        width={px}
        height={BAR_HEIGHT}
      />
    )
  }

  const settingsPanel = (): RenderElement => (
    <Box key="settings" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1} {...panelBg}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Settings</Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>also in /config · /usage-band</Text>
          <Button key="settings-close" label="Close" onPress={() => act.closePanel()} />
        </Box>
      </Box>
      {SETTINGS.map(s => (
        <Box key={`setting-${s.part}`} flexDirection="row">
          <Button
            key={`show-${s.part}`}
            label={`${shown[s.part] ? '☑' : '☐'} ${s.label}`}
            onPress={() => act.setShown(s.part, !shown[s.part])}
          />
        </Box>
      ))}
    </Box>
  )

  const skillButtons = (prefix: string, names: readonly string[], none: string): RenderElement =>
    names.length === 0 ? (
      <Text dimColor>{none}</Text>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {names.map(name => (
          <Button key={`${prefix}-${name}`} label={`/${name}`} onPress={() => act.insertSkill(name)} />
        ))}
      </Box>
    )

  const hotPanel = (): RenderElement => (
    <Box key="hot" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1} {...panelBg}>
      <Text bold>Hot commands</Text>
      <Text dimColor>Recently used</Text>
      {skillButtons('skill', d.recentSkills, 'No skills used yet')}
      <Box marginTop={1}>
        <Text dimColor>This project</Text>
      </Box>
      {skillButtons('project', d.projectSkills, 'No skills in this project')}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {shown.limits && d.limits.length === 0 ? (
        <Text dimColor>5h / weekly limits appear after the first API response</Text>
      ) : null}
      {/* Two columns, so the right-hand parts (resets, thinking) start at one
          place whatever each row's left part measures. */}
      <Box flexDirection="row">
        <Box flexDirection="column">
          {limitRows.map(r => limitLine(Box, Text, r, drawBar(r)))}
          {shown.context ? (
            <Box key="context" flexDirection="row" alignItems="center" gap={1}>
              <Box width={11}>
                <Text bold>context</Text>
              </Box>
              {contextBar()}
              <Box width={4}>
                <Text color={ZONE_HEX[zone]} bold>{`${Math.round(ctxPct)}%`}</Text>
              </Box>
            </Box>
          ) : null}
          {shown.session ? (
            <Box key="session" flexDirection="row" alignItems="center" gap={1}>
              <Box width={11}>
                <Text bold>session</Text>
              </Box>
              <Text color="success" bold>↑</Text>
              <Text bold>{fmtTokens(totalIn)}</Text>
              <Text dimColor>{t.cacheRead > 0 ? `in (cache ${fmtTokens(t.cacheRead)})` : 'in'}</Text>
              <Text color="error" bold>↓</Text>
              <Text bold>{fmtTokens(t.output)}</Text>
              <Text dimColor>out</Text>
              <Text bold color="success">{d.costUsd === null ? '$ —' : `$${d.costUsd.toFixed(2)}`}</Text>
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          {limitRows.map(r =>
            sideLine(
              Box,
              Text,
              `reset-${r.kind}`,
              'resets',
              <Text bold>{fmtResetAt(r.resetsAt, d.at)}</Text>,
              <Text dimColor>{fmtResetIn(r.resetsAt, d.at)}</Text>,
            ),
          )}
          {shown.context
            ? sideLine(
                Box,
                Text,
                'zone',
                'zone',
                <Text color={ZONE_HEX[zone]} bold>{ZONE_LABEL[zone]}</Text>,
                <Text dimColor>{ctx.tokens === null ? '—' : `${fmtCompact(ctxTokens)} / ${fmtCompact(ctx.window)}`}</Text>,
              )
            : null}
          {shown.session
            ? sideLine(
                Box,
                Text,
                'thinking',
                'thinking',
                <Text bold>{fmtMinutes(d.thinkMs)}</Text>,
                <Text color={SPARK_HEX}>✻</Text>,
              )
            : null}
        </Box>
      </Box>
      {hasTop(d) && hasBottom(d) ? (
        <Text color="subtle" wrap="truncate-end">
          {'─'.repeat(Math.max(1, d.columns))}
        </Text>
      ) : null}
      {d.tasks.length > 0 ? (
        <Box key="tasks" flexDirection="column" paddingX={2} paddingY={1}>
          {d.tasks.map(task => (
            <Box key={`task-${task.id}`} flexDirection="row" gap={1}>
              <Text color="suggestion" bold>{task.id}</Text>
              <Link href={task.url} label={task.title || task.url} />
            </Box>
          ))}
        </Box>
      ) : null}
      {shown.buttons ? (
        <Box key="buttons" flexDirection="row" justifyContent="flex-end">
          <Box flexDirection="row" gap={1}>
            <Button
              key="stages-toggle"
              label={open === 'stages' ? 'Workflow stage ▴' : 'Workflow stage ▾'}
              onPress={() => act.toggle('stages')}
            />
            <Button
              key="retro-toggle"
              label={d.recap.status === 'running' ? `${RECAP_TITLE} ✻` : `${RECAP_TITLE} ▸`}
              onPress={() => act.togglePane('retro')}
            />
            <Button
              key="pr-toggle"
              label={d.pr.status === 'running' ? 'Generate PR description ✻' : 'Generate PR description ▸'}
              onPress={() => act.togglePane('pr')}
            />
            <Button
              key="hot-toggle"
              label={open === 'hot' ? 'Hot commands ▴' : 'Hot commands ▾'}
              onPress={() => act.toggle('hot')}
            />
            <Button key="settings-toggle" label={open === 'settings' ? '⚙ ▴' : '⚙ ▾'} onPress={() => act.toggle('settings')} />
          </Box>
        </Box>
      ) : null}
      {open === 'settings' ? settingsPanel() : null}
      {shown.buttons && open === 'stages' ? stagesPanel() : null}
      {shown.buttons && open === 'hot' ? hotPanel() : null}
    </Box>
  )
}
