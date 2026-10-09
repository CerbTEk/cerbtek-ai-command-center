import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import KairoHelp from '../src/KairoHelp'
afterEach(cleanup)
function guide(query,title){
  render(<KairoHelp userId="reader" organizationId="company" section="Agents" data={{}} ready={false}/> )
  fireEvent.click(screen.getByRole('button',{name:'Help with Kairo'}))
  fireEvent.change(screen.getByLabelText('Search help'),{target:{value:query}})
  fireEvent.click(screen.getByRole('button',{name:new RegExp(title)}))
  return screen.getByRole('dialog').querySelector('article').textContent
}
describe('safety guidance in the actual help panel',()=>{
  it('describes immutable independent review instead of a confidence-authorized execution field',()=>{
    const content=guide('agent controls','Understand agent workflow controls')
    expect(content).toContain('A different authorized person')
    expect(content).toContain('immutable saved steps')
    expect(content).toContain('Only Executed completes')
    expect(content).toContain('confidence cannot authorize execution')
    expect(content).not.toContain('field is entered manually')
  })
  it('warns against replaying uncertain email and distinguishes acceptance from delivery',()=>{
    const content=guide('email approval','Review an email approval request')
    expect(content).toContain('Do not resend or recreate')
    expect(content).toContain('acceptance does not confirm delivery')
    expect(content).toContain('different authorized person')
  })
})
