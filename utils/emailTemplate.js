const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

const getEmailTemplate = (templateName, subject, variables = {}) => {
  const templatesDir = path.join(process.cwd(), 'templates');

  const readAndCompile = (fileName) => {
    const filePath = path.join(templatesDir, fileName);
    const templateContent = fs.readFileSync(filePath, 'utf-8');
    const compiled = handlebars.compile(templateContent);
    return compiled(variables);
  };

  const html = readAndCompile(`${templateName}.html`);
  const plain = readAndCompile(`${templateName}.txt`);
  console.log(html,plain,'plainplainplainplain')
  return { subject, html, plain };
};


module.exports = {
    getEmailTemplate
  };
