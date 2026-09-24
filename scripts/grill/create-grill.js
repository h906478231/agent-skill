#!/usr/bin/env node
/**
 * Grill 快速创建脚本
 *
 * 用法:
 *   node scripts/create-grill.js <change-name>
 *
 * 功能:
 *   1. 创建 grill-<name> 目录
 *   2. 从模板生成 discussion-log.md
 *   3. 自动填充变更名称、风险等级等基本信息
 */

const fs = require('fs');
const path = require('path');

/**
 * 定位使用者项目的根目录（即包含 openspec/ 的目录）。
 *
 * 脚本有两种运行形态，不能只靠 __dirname：
 *   1. 安装形态：<项目根>/scripts/create-grill.js，脚本上一级即项目根；
 *   2. 仓库形态：<仓库根>/scripts/grill/create-grill.js，上一级是 scripts/，
 *      必须从 process.cwd() 逐级上溯才能找到 openspec/。
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

/**
 * 定位 discussion-log 模板。
 *
 * 按优先级探测，覆盖两种运行形态：
 *   1. 使用者项目：<项目根>/.claude/templates/（install.sh 的安装形态）
 *   2. 本 skill 仓库内直接运行：<仓库根>/skills/openspec-grill-policy/templates/
 *
 * @returns {string|null} 模板绝对路径，找不到返回 null
 */
function resolveTemplatePath(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.claude/templates/grill-discussion-log-template.md'),
    path.join(__dirname, '../../skills/openspec-grill-policy/templates/grill-discussion-log-template.md')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function createGrill(changeName) {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    console.error('❌ 未找到 openspec/ 目录，无法创建 Grill');
    console.error(`   脚本位置: ${__dirname}`);
    console.error(`   当前目录: ${process.cwd()}`);
    console.error('   请在包含 openspec/ 的项目根目录下运行');
    process.exit(1);
  }

  const changesDir = path.join(projectRoot, 'openspec/changes');
  const grillDir = path.join(changesDir, `grill-${changeName}`);
  const targetPath = path.join(grillDir, 'discussion-log.md');

  // 1. 检查原变更是否存在
  const changeDir = path.join(changesDir, changeName);
  if (!fs.existsSync(changeDir)) {
    console.error(`❌ 变更 ${changeName} 不存在`);
    console.error(`   请先确认 openspec/changes/${changeName}/ 存在`);
    process.exit(1);
  }

  // 2. 检查 grill 是否已存在
  if (fs.existsSync(grillDir)) {
    console.error(`❌ grill-${changeName} 已存在`);
    console.error(`   路径: ${grillDir}`);
    process.exit(1);
  }

  // 3. 读取原变更的 proposal.md 提取信息
  const proposalPath = path.join(changeDir, 'proposal.md');
  let metadata = {
    level: 'L?',
    breaking: '待确认',
    startDate: new Date().toISOString().split('T')[0]
  };

  if (fs.existsSync(proposalPath)) {
    const content = fs.readFileSync(proposalPath, 'utf8');

    const levelMatch = content.match(/等级[：:]\s*(L[0-3])/i) ||
                       content.match(/风险等级[：:]\s*(L[0-3])/i) ||
                       content.match(/level[：:]\s*(L[0-3])/i);
    if (levelMatch) {
      metadata.level = levelMatch[1];
    }

    const isBreaking = /BREAKING/i.test(content);
    metadata.breaking = isBreaking ? '是' : '否';
  }

  // 4. 读取模板
  const templatePath = resolveTemplatePath(projectRoot);
  if (!templatePath) {
    console.error('❌ 模板文件不存在');
    console.error('   已尝试:');
    console.error(`   - ${path.join(projectRoot, '.claude/templates/grill-discussion-log-template.md')}`);
    console.error(`   - ${path.join(__dirname, '../../skills/openspec-grill-policy/templates/grill-discussion-log-template.md')}`);
    console.error('   请先执行 install.sh，或在 agent-skills 仓库内运行');
    process.exit(1);
  }

  let template = fs.readFileSync(templatePath, 'utf8');

  // 5. 替换占位符
  // 仅替换「访谈基本信息」表格中本次能确定的字段，且按整行锚定。
  // 早期实现用 /是 \/ 否/g 和 /YYYY-MM-DD/g 全局替换，会把「阻塞性」「已同步」
  // 「是否创建ADR」等后续待填项一并覆写成 BREAKING / 开始日期，甚至产出
  // `否 / 待同步` 这类畸形文本；「访谈结束日期（进行中则留空）」的留空语义
  // 也会被抹掉。未确定的字段一律保留原占位符，交由访谈过程填写。
  template = template.replace(/\{变更名称\}/g, changeName);
  template = template.replace(/(\| 风险等级 \| )L\{0\/1\/2\/3\} \|/, `$1${metadata.level} |`);
  template = template.replace(/(\| BREAKING \| ).+? \|/, `$1${metadata.breaking} |`);
  template = template.replace(/(\| 访谈开始日期 \| ).+? \|/, `$1${metadata.startDate} |`);

  // 6. 创建目录和文件
  fs.mkdirSync(grillDir, { recursive: true });
  fs.writeFileSync(targetPath, template, 'utf8');

  console.log('✅ Grill 目录创建成功');
  console.log('');
  console.log(`📁 目录: ${grillDir}`);
  console.log(`📄 文件: discussion-log.md`);
  console.log('');
  console.log('📊 变更信息:');
  console.log(`   名称: ${changeName}`);
  console.log(`   风险等级: ${metadata.level}`);
  console.log(`   BREAKING: ${metadata.breaking}`);
  console.log(`   开始日期: ${metadata.startDate}`);
  console.log('');
  console.log('🚀 下一步:');
  console.log('   1. 编辑 discussion-log.md 补充「事实依据」');
  console.log('   2. 启动 /openspec-grill 开始访谈');
  console.log('   3. 每轮访谈后更新「讨论轮次记录」');
  console.log('   4. 访谈结束后补充「Grill总结」');
  console.log('');
  console.log('📖 参考:');
  console.log('   docs/grill-gate-manual.md - 门禁操作手册');
  console.log('   docs/openspec-workflow-guide.md - 工作流指南');
}

// 主入口
const changeName = process.argv[2];

if (!changeName) {
  console.log('用法: node scripts/create-grill.js <change-name>');
  console.log('');
  console.log('示例:');
  console.log('  node scripts/create-grill.js agent-streaming-replies');
  console.log('');
  console.log('将创建:');
  console.log('  openspec/changes/grill-<change-name>/discussion-log.md');
  process.exit(1);
}

createGrill(changeName);
