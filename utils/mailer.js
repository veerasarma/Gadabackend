const nodemailer = require('nodemailer');
const hbsModule = require('nodemailer-express-handlebars');
const hbs = hbsModule?.default || hbsModule;

const path = require('path');
console.log(process.env.SMTP_HOST,'process.env.SMTP_HOST')
console.log(process.env.SMTP_USER,'process.env.SMTP_USER')
console.log(typeof process.env.SMTP_PASS,'process.env.SMTP_PASS')
console.log(process.env.SMTP_PORT,'process.env.SMTP_PORT')

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Setup handlebars template engine
const handlebarOptions = {
  viewEngine: {
    extname: '.html',
    partialsDir: path.resolve('./templates/'),
    layoutsDir: path.resolve('./templates/'), // required for newer versions
    defaultLayout: false,
  },
  viewPath: path.resolve('./templates/'),
  extName: '.html',
};  
transporter.use('compile', hbs(handlebarOptions));

// Send Email Function
const sendEmail = async (to, subject, templateName, context) => {
  await transporter.sendMail({
    from: `"${process.env.SYSTEM_NAME}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    template: templateName,
    context
  });
};

module.exports = {
  sendEmail,
};