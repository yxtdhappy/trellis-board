const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const data = Buffer.isBuffer(item.data)
      ? item.data
      : Buffer.from(item.data ?? "", "utf8");
    const mode = item.mode ?? (item.directory ? 0o040755 : 0o100644);
    const flags = 0x0800;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const external = (((mode << 16) >>> 0) | (item.directory ? 0x10 : 0)) >>> 0;
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildTemplateZip(overrides = {}) {
  const manifest = {
    version: "test-template-1",
    defaultTools: [".opencode", ".agents"],
    tools: [".opencode", ".agents", ".codex"],
    files: ["AGENTS.md", ".gitattributes", ".trellis", ".opencode", ".agents", ".codex"],
    ...overrides.manifest
  };
  const files = {
    "AGENTS.md": "# Test workspace\n",
    ".gitattributes": "* text=auto\n",
    ".trellis/.version": "0.6.16\n",
    ".trellis/scripts/init_developer.py": "print('test')\n",
    ".opencode/agent.md": "# opencode\n",
    ".agents/skill.md": "# agents\n",
    ".codex/config.toml": "model = \"test\"\n",
    ...overrides.files
  };
  const entries = [
    { name: "template-manifest.json", data: JSON.stringify(manifest, null, 2) },
    ...Object.entries(files)
      .filter(([, data]) => data != null)
      .map(([name, data]) => ({ name, data }))
  ];
  return buildZip(entries);
}
