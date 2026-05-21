"use strict";

// Aggregates the tool categories. ToolRunner filters this list by role
// at boot time so each agent only sees the tools its role grants. The
// devops/* tools are gated to role='devops' only — they're never even
// instantiated for analyst or developer runtimes.

module.exports = [
  ...require('./portal'),
  ...require('./docs'),
  ...require('./system'),
  ...require('./repo'),
  ...require('./github'),
  ...require('./devops')
];
