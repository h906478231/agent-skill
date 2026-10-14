#!/usr/bin/env node
/**
 * Grill 门禁检查脚本
 *
 * 用法:
 *   node scripts/grill-check.js check-required <change-name>
 *   node scripts/grill-check.js validate <change-name>
 *   node scripts/grill-check.js health-report
 */

const fs = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch (e) {
  console.error('❌ 缺少依赖 js-yaml，请运行: npm install --save-dev js-yaml');
  process.exit(1);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 定位并加载门禁规则配置。
 *
 * 脚本可能在两种位置被调用，配置的解析基准不同，因此按优先级依次探测：
 *   1. 使用者项目：<项目根>/.claude/grill-policy.yml（install.sh 的安装形态）
 *   2. 本 skill 仓库内直接运行：<仓库根>/skills/openspec-grill-policy/grill-policy.yml
 * 不再使用 __dirname 相对拼接——脚本位于 scripts/grill/ 时 `../.claude/`
 * 会解析到 scripts/.claude/，在两种形态下都必然找不到配置。
 */
function loadPolicy() {
  const candidates = [
    path.join(process.cwd(), '.claude/grill-policy.yml'),
    path.join(__dirname, '../../skills/openspec-grill-policy/grill-policy.yml'),
    path.join(__dirname, '../.claude/grill-policy.yml')
  ];

  const policyPath = candidates.find(p => fs.existsSync(p));
  if (!policyPath) {
    console.error('❌ 未找到 grill-policy.yml，已尝试:');
    candidates.forEach(p => console.error(`   - ${p}`));
    console.error('   请在项目根目录运行，或先执行 install.sh');
    process.exit(1);
  }
  return yaml.load(fs.readFileSync(policyPath, 'utf8'));
}

/**
 * 定位使用者项目的根目录（即包含 openspec/ 的目录）。
 *
 * 脚本有两种运行形态，不能只靠 __dirname：
 *   1. 安装形态：<项目根>/scripts/grill-check.js，脚本上一级即项目根；
 *   2. 仓库形态：<仓库根>/scripts/grill/grill-check.js，上一级是 scripts/，
 *      必须从 process.cwd() 逐级上溯才能找到 openspec/。
 * 早期实现直接拼 `__dirname/../openspec`，在仓库形态下必然解析到
 * scripts/openspec/，导致门禁判定读不到 proposal.md 而静默降级。
 *
 * @returns {string|null} 项目根绝对路径，找不到返回 null（由调用方明确报错）
 */
function resolveProjectRoot() {
  // 安装形态优先：脚本同级目录下存在 openspec/ 即为项目根
  const installedRoot = path.join(__dirname, '..');
  if (fs.existsSync(path.join(installedRoot, 'openspec'))) {
    return installedRoot;
  }

  // 仓库形态：从当前工作目录逐级上溯
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, 'openspec'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

function loadChangeMetadata(changeName) {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    console.error('❌ 未找到 openspec/ 目录，无法读取变更信息');
    console.error(`   脚本位置: ${__dirname}`);
    console.error(`   当前目录: ${process.cwd()}`);
    console.error('   请在包含 openspec/ 的项目根目录下运行');
    return null;
  }

  const proposalPath = path.join(projectRoot, 'openspec/changes', changeName, 'proposal.md');
  if (!fs.existsSync(proposalPath)) {
    return null;
  }

  const content = fs.readFileSync(proposalPath, 'utf8');

  // 提取风险等级
  const levelMatch = content.match(/等级[：:]\s*(L[0-3])/i) ||
                     content.match(/风险等级[：:]\s*(L[0-3])/i) ||
                     content.match(/level[：:]\s*(L[0-3])/i);
  const level = levelMatch ? levelMatch[1] : null;

  // 提取 BREAKING 标记
  const isBreaking = /BREAKING/i.test(content);

  // 提取其他属性
  const isNewModule = /新增.*模块|独立.*模块|new.*module/i.test(content);
  const isSecuritySensitive = /安全敏感|security.*sensitive|认证|授权|authentication|authorization/i.test(content);
  const hasDataMigration = /数据迁移|data.*migration|migrate.*data/i.test(content);
  const isExternalApi = /对外.*API|external.*API|公开.*接口/i.test(content);
  const isProtocolChange = /协议.*变更|protocol.*change/i.test(content);

  return {
    level,
    isBreaking,
    isNewModule,
    isSecuritySensitive,
    hasDataMigration,
    isExternalApi,
    isProtocolChange
  };
}

function checkGrillRequired(changeName, metadata, policy) {
  const reasons = [];

  if (!metadata) {
    console.warn(`⚠️  无法读取 ${changeName}/proposal.md，无法自动判断`);
    return { required: null, reasons: [] };
  }

  // 检查风险等级
  if (policy.mandatory_grill.risk_level.includes(metadata.level)) {
    reasons.push(`风险等级为 ${metadata.level}`);
  }

  // 检查变更属性
  if (metadata.isBreaking && policy.mandatory_grill.change_attributes.find(a => a.breaking)) {
    reasons.push('BREAKING 变更');
  }
  if (metadata.isNewModule && policy.mandatory_grill.change_attributes.find(a => a.new_module)) {
    reasons.push('新增独立模块');
  }
  if (metadata.isSecuritySensitive && policy.mandatory_grill.change_attributes.find(a => a.security_sensitive)) {
    reasons.push('安全敏感变更');
  }
  if (metadata.hasDataMigration && policy.mandatory_grill.change_attributes.find(a => a.data_migration)) {
    reasons.push('涉及数据迁移');
  }

  // 检查影响范围
  if (metadata.isExternalApi && policy.mandatory_grill.impact_scope.find(s => s.external_api)) {
    reasons.push('对外 API 变更');
  }
  if (metadata.isProtocolChange && policy.mandatory_grill.impact_scope.find(s => s.protocol_change)) {
    reasons.push('协议变更');
  }

  return {
    required: reasons.length > 0,
    reasons
  };
}

function validateGrillOutput(changeName, policy) {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    return {
      valid: false,
      errors: ['未找到 openspec/ 目录，请在项目根目录下运行']
    };
  }

  const grillPath = path.join(projectRoot, 'openspec/changes', `grill-${changeName}`, 'discussion-log.md');

  if (!fs.existsSync(grillPath)) {
    return {
      valid: false,
      errors: ['grill-<name>/discussion-log.md 不存在']
    };
  }

  const content = fs.readFileSync(grillPath, 'utf8');
  const errors = [];
  const warnings = [];

  // 检查必须的章节
  const requiredSections = [
    'Grill总结',
    '已验证的假设',
    '未验证的假设',
    '建议行动',
    'Grill门禁决策'
  ];

  for (const section of requiredSections) {
    if (!content.includes(section)) {
      errors.push(`缺少「${section}」章节`);
    }
  }

  // 检查决策字段
  if (!content.match(/状态[：:]\s*(✓|⚠️|✗)/)) {
    errors.push('缺少明确的门禁决策状态');
  }

  if (!content.match(/签字[：:]/)) {
    warnings.push('缺少签字');
  }

  if (!content.match(/日期[：:]\s*\d{4}-\d{2}-\d{2}/)) {
    warnings.push('缺少日期');
  }

  // 检查风险标注
  const hasHighRisk = /🔴.*HIGH/i.test(content);
  const hasRiskAssessment = /风险等级/i.test(content);

  if (!hasRiskAssessment && !hasHighRisk) {
    warnings.push('未发现风险等级标注（建议标注 🔴 HIGH / 🟡 MEDIUM）');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// ============================================================================
// 命令: check-grill-required
// ============================================================================

function checkGrillRequiredCommand() {
  const changeName = process.argv[3];
  if (!changeName) {
    console.error('❌ 用法: node scripts/grill-check.js check-required <change-name>');
    process.exit(1);
  }

  console.log(`🔍 检查变更: ${changeName}`);
  console.log('');

  const policy = loadPolicy();
  const metadata = loadChangeMetadata(changeName);
  const result = checkGrillRequired(changeName, metadata, policy);

  if (result.required === null) {
    console.log('⚠️  无法自动判断，请人工检查：');
    console.log('   1. 查看 proposal.md 确认风险等级');
    console.log('   2. 参考 docs/grill-gate-manual.md 第 1 步');
    process.exit(0);
  }

  if (result.required) {
    console.log('✅ 需要 Grill');
    console.log('');
    console.log('理由:');
    result.reasons.forEach(r => console.log(`  • ${r}`));
    console.log('');
    console.log('下一步:');
    console.log(`  mkdir -p openspec/changes/grill-${changeName}`);
    console.log(`  touch openspec/changes/grill-${changeName}/discussion-log.md`);
    console.log('  /openspec-grill');
    process.exit(0);
  } else {
    console.log('✅ 不需要强制 Grill（可选）');
    console.log('');
    console.log('检测到:');
    console.log(`  • 风险等级: ${metadata.level || '未标注'}`);
    console.log(`  • BREAKING: ${metadata.isBreaking ? '是' : '否'}`);
    console.log('');
    console.log('下一步:');
    console.log('  /openspec-explore → design.md → propose');
    process.exit(0);
  }
}

// ============================================================================
// 命令: validate-grill
// ============================================================================

function validateGrillCommand() {
  const changeName = process.argv[3];
  if (!changeName) {
    console.error('❌ 用法: node scripts/grill-check.js validate <change-name>');
    process.exit(1);
  }

  console.log(`🔍 验证 Grill 产出: grill-${changeName}`);
  console.log('');

  const policy = loadPolicy();
  const result = validateGrillOutput(changeName, policy);

  if (result.valid) {
    console.log('✅ Grill 产出完整');
    if (result.warnings.length > 0) {
      console.log('');
      console.log('⚠️  建议补充:');
      result.warnings.forEach(w => console.log(`  • ${w}`));
    }
    process.exit(0);
  } else {
    console.log('❌ Grill 产出不完整');
    console.log('');
    console.log('缺失项:');
    result.errors.forEach(e => console.log(`  • ${e}`));

    if (result.warnings.length > 0) {
      console.log('');
      console.log('⚠️  建议补充:');
      result.warnings.forEach(w => console.log(`  • ${w}`));
    }

    console.log('');
    console.log('参考: docs/grill-gate-manual.md 第 4 步');
    process.exit(1);
  }
}

// ============================================================================
// 命令: grill-health-report
// ============================================================================

function grillHealthReportCommand() {
  console.log('📊 Grill 健康度报告');
  console.log('='.repeat(60));
  console.log('');

  const policy = loadPolicy();

  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    console.error('❌ 未找到 openspec/ 目录，请在项目根目录下运行');
    process.exit(1);
  }

  const changesDir = path.join(projectRoot, 'openspec/changes');

  if (!fs.existsSync(changesDir)) {
    console.error('❌ openspec/changes 目录不存在');
    process.exit(1);
  }

  const allChanges = fs.readdirSync(changesDir)
    .filter(name => fs.statSync(path.join(changesDir, name)).isDirectory());

  const stats = {
    total: 0,
    l3: 0,
    l2: 0,
    l1: 0,
    l0: 0,
    needGrill: 0,
    hasGrill: 0,
    grillComplete: 0,
    grillIncomplete: 0,
    issues: []
  };

  allChanges.forEach(changeName => {
    if (changeName.startsWith('grill-')) return; // 跳过 grill 目录本身

    stats.total++;

    const metadata = loadChangeMetadata(changeName);
    if (!metadata) return;

    // 统计风险等级
    if (metadata.level === 'L3') stats.l3++;
    else if (metadata.level === 'L2') stats.l2++;
    else if (metadata.level === 'L1') stats.l1++;
    else if (metadata.level === 'L0') stats.l0++;

    // 检查是否需要 Grill
    const grillCheck = checkGrillRequired(changeName, metadata, policy);
    if (grillCheck.required) {
      stats.needGrill++;

      // 检查是否有 Grill
      const grillPath = path.join(changesDir, `grill-${changeName}/discussion-log.md`);
      if (fs.existsSync(grillPath)) {
        stats.hasGrill++;

        // 检查 Grill 完整性
        const validation = validateGrillOutput(changeName, policy);
        if (validation.valid) {
          stats.grillComplete++;
        } else {
          stats.grillIncomplete++;
          stats.issues.push({
            change: changeName,
            level: metadata.level,
            errors: validation.errors
          });
        }
      } else {
        stats.issues.push({
          change: changeName,
          level: metadata.level,
          errors: ['缺少 grill 目录']
        });
      }
    }
  });

  // 输出统计
  console.log('📈 总体统计');
  console.log(`  变更总数: ${stats.total}`);
  console.log(`  风险分布: L3=${stats.l3}, L2=${stats.l2}, L1=${stats.l1}, L0=${stats.l0}`);
  console.log('');

  console.log('🚦 Grill 覆盖率');
  console.log(`  需要 Grill: ${stats.needGrill}`);
  console.log(`  已有 Grill: ${stats.hasGrill}`);
  console.log(`  完整 Grill: ${stats.grillComplete}`);
  console.log(`  不完整 Grill: ${stats.grillIncomplete}`);
  console.log('');

  const completionRate = stats.needGrill > 0
    ? Math.round(stats.grillComplete / stats.needGrill * 100)
    : 0;

  console.log(`  ✅ Grill 完成率: ${completionRate}% (目标: >= 80%)`);

  if (completionRate < 80) {
    console.log(`  ⚠️  未达标，需要提升 ${80 - completionRate}%`);
  }
  console.log('');

  // 输出问题清单
  if (stats.issues.length > 0) {
    console.log('❌ 问题清单');
    console.log('-'.repeat(60));
    stats.issues.forEach((issue, idx) => {
      console.log(`${idx + 1}. ${issue.change} (${issue.level})`);
      issue.errors.forEach(e => console.log(`   • ${e}`));
    });
    console.log('');
  }

  // 输出建议
  console.log('💡 建议行动');
  if (stats.needGrill > stats.hasGrill) {
    const missing = stats.needGrill - stats.hasGrill;
    console.log(`  • 为 ${missing} 个缺失 Grill 的变更补充访谈`);
  }
  if (stats.grillIncomplete > 0) {
    console.log(`  • 为 ${stats.grillIncomplete} 个不完整的 Grill 补充总结`);
  }
  if (completionRate >= 80) {
    console.log(`  • ✅ Grill 完成率达标，继续保持`);
  }
  console.log('');

  process.exit(stats.issues.length > 0 ? 1 : 0);
}

// ============================================================================
// 主入口
// ============================================================================

const command = process.argv[2];

switch (command) {
  case 'check-required':
    checkGrillRequiredCommand();
    break;
  case 'validate':
    validateGrillCommand();
    break;
  case 'health-report':
    grillHealthReportCommand();
    break;
  default:
    console.log('用法:');
    console.log('  node scripts/grill-check.js check-required <change-name>');
    console.log('  node scripts/grill-check.js validate <change-name>');
    console.log('  node scripts/grill-check.js health-report');
    process.exit(1);
}
