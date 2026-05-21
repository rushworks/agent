"use strict";

// Aggregates the three tool categories. ToolRunner filters this list by
// role at boot time so analysts never even see developer tools as options.

module.exports = [
  ...require('./portal'),
  ...require('./docs'),
  ...require('./system'),
  ...require('./repo'),
  ...require('./github')
];
