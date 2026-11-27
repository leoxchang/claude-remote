-- 002: 会话模型选择；model 为 NULL 表示跟随 Mac 默认模型。
ALTER TABLE sessions ADD COLUMN model TEXT;
