/**
 * Parser de body RAW para uploads .xlsx (importação de reservas).
 * Aceita o MIME do xlsx e application/octet-stream; limite de 5 MB.
 * Sem este middleware o express.json deixa req.body como {} e a importação falha.
 */
const express = require('express');

module.exports = express.raw({
  type: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
  ],
  limit: '5mb',
});
