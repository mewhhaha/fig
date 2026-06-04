(FnDecl (FnTail (FnName (LowerIdent) @function)))
(Primary (LowerIdent) @variable)
(Call (Primary (LowerIdent) @function.call) "(")
(Primary (StaticBuiltin (LowerIdent) @function.builtin))
(TypePrimary (StaticBuiltin (LowerIdent) @function.builtin))
(TypeAtom (LowerIdent) @type.parameter)
(TypeFnDecl (PascalIdent) @type)
(ConstDecl (LowerIdent) @constant)
(ImportBindingItems (LowerIdent) @constant)
(ImportBindingItems (PascalIdent) @type)
(ConstDecl (FieldName (LowerIdent) @constant))
(Param (PatternIdent (LowerIdent) @variable.parameter))
(Param (PatternIdent (PascalIdent) @constructor))
(Param (FieldName (LowerIdent) @variable.parameter))
(ConstFnParams (LowerIdent) @variable.parameter)
(BlockLetDecl (LowerIdent) @variable)
(BlockLetDecl (FieldName (LowerIdent) @variable))
(BlockLetTail (LowerIdent) @variable)
(TopLetDecl (LowerIdent) @variable)
(TopLetDecl (FieldName (LowerIdent) @variable))
(TypeShapeSlot (ShapeSlotKey (LowerIdent) @variable.other.member))
(ShapeSlot (ShapeSlotKey (LowerIdent) @variable.other.member))
(Call "." (LowerIdent) @variable.other.member)
(Primary (PascalIdent) @constructor)
"import" @keyword.control.import
"type" @keyword.type
"const" @keyword
"fn" @keyword.function
"infix" @keyword
"infixl" @keyword
"infixr" @keyword
"let" @keyword
"match" @keyword.control
(Visibility) @keyword
(TypeParamsDecl) @type.parameter
(TypeShapeRepeat) @number
(CountRepeat) @number
(PascalIdentRepeat) @number
(TypeRepeatPrefix) @number
(String) @string
(Number) @number
(Bool) @constant.builtin
(Comment) @comment
"do" @keyword
"else" @keyword
"enum" @keyword
"if" @keyword
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"-" @operator
"->" @operator
"." @punctuation.delimiter
".." @operator
".." @operator
"..." @operator
":" @punctuation.delimiter
"::" @operator
";" @punctuation.delimiter
"<-" @operator
"=" @operator
"=>" @operator
"@" @operator
"@[" @operator
"@assert" @operator
"@external" @operator
"@profile" @operator
"@trace" @operator
"[" @punctuation.bracket
"\\" @operator
"]" @punctuation.bracket
"{" @punctuation.bracket
"{}" @operator
"|" @operator
"}" @punctuation.bracket
(fenced_text) @string.special
(Char) @constant
(LiteralType) @constant
(DoStrategy (StaticBuiltin) @keyword.directive)
(BranchHint) @keyword.directive
(DoBindStmt (LowerIdent) @variable)
(CollectionValue (CollectionOpen) @punctuation.bracket)
(Op) @operator
